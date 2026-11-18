/**
 * LLM 桥 —— 把 BabelDOC 的 OpenAI 兼容请求接到 DSH 宿主模型上
 *
 * 为什么需要它：BabelDOC 是一个独立的 Python 进程，自己拿 openai SDK 发 HTTP，
 * 读不到 DSH 宿主的账号凭据（那不是静态 key，而是登录态 + 模型准入）。要让翻译
 * 复用「当前会话正在用的模型」，只能在本地起一个 OpenAI 兼容的小服务，把请求
 * 转成 ctx.llm.prepareCall → call.stream，再把流式结果聚合回非流式响应。
 *
 * 安全边界：只绑 127.0.0.1、随机端口、进程级随机 bearer token；fiber 释放时关闭。
 * 协议边界：BabelDOC 只用非流式 chat.completions（单轮 system+user，读
 * choices[0].message.content 与 usage），所以这里不实现 SSE，只做请求-响应。
 * 不新增 npm 依赖：node:http + node:crypto 即可。
 */
import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

/** 宿主 llm 服务是否可用（auto 模式据此决定走 host 还是回落 config）。 */
export function isLlmAvailable(ctx) {
  return Boolean(ctx.get('llm'))
}

/**
 * 解析翻译要用的模型路由。优先级：
 *   1. 插件配置 llmBridge.provider/model 显式指定；
 *   2. DSH 默认模型 agentDefaultModel.currentSelection()；
 *   3. 宿主只注册了一个 provider 时自动取它的第一个模型。
 * 都拿不到就抛错，把「该怎么配」说清楚，而不是静默用一个错的模型。
 * @returns {Promise<{provider:string, model:string, reasoningEffort?:string}>}
 */
export async function resolveBridgeRoute(ctx, bridgeConfig = {}) {
  if (bridgeConfig.provider && bridgeConfig.model) {
    return {
      provider: bridgeConfig.provider,
      model: bridgeConfig.model,
      ...(bridgeConfig.reasoningEffort ? { reasoningEffort: bridgeConfig.reasoningEffort } : {}),
    }
  }

  const defaultModel = ctx.get('agentDefaultModel')
  if (defaultModel && typeof defaultModel.currentSelection === 'function') {
    const sel = defaultModel.currentSelection()
    if (sel && sel.provider && sel.model) return sel
  }

  const llm = ctx.get('llm')
  if (llm && typeof llm.listProviders === 'function') {
    const providers = llm.listProviders()
    if (providers.length === 1) {
      const models = await llm.listModels(providers[0].id)
      if (models.length > 0) return { provider: providers[0].id, model: models[0].id }
    }
  }

  throw new Error(
    'LLM 桥无法确定翻译模型：请在插件配置里写 llmBridge.provider 与 llmBridge.model，' +
      '或先在 DSH 里设置默认模型（agentDefaultModel）。宿主未注册任何可用模型时也会到这里。',
  )
}

/** 把 OpenAI 的 messages 拆成宿主 GenerateOptions 需要的 system 文本 + 用户消息。 */
function splitMessages(openaiMessages) {
  const systemParts = []
  const messages = []
  for (const m of openaiMessages || []) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('')
        : ''
    if (m.role === 'system') {
      systemParts.push(text)
    } else if (m.role === 'user') {
      // RequestUserInput：无持久身份的一次性用户输入，正合翻译这种单轮场景
      messages.push({ role: 'user', content: [{ type: 'text', text }] })
    } else if (m.role === 'assistant') {
      // BabelDOC 翻译是单轮，正常不会有助手历史；真出现了就并成用户文本，避免丢内容
      messages.push({ role: 'user', content: [{ type: 'text', text }] })
    }
  }
  return { system: systemParts.join('\n\n') || undefined, messages }
}

/** 宿主 TokenUsage → OpenAI usage。inputTokens 不含缓存， billed prompt 要补回缓存读写。 */
function toOpenAiUsage(usage) {
  const prompt = (usage?.inputTokens || 0) + (usage?.cacheReadTokens || 0) + (usage?.cacheWriteTokens || 0)
  const completion = usage?.outputTokens || 0
  const total = usage?.totalTokens ?? prompt + completion
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
}

/** finish.kind → OpenAI finish_reason。error/aborted 不在这里映射，走错误分支。 */
function toFinishReason(kind) {
  if (kind === 'max-tokens') return 'length'
  if (kind === 'tool-calls') return 'tool_calls'
  return 'stop'
}

/** 判断一个宿主失败是否该映射成 429（让 BabelDOC 的限流重试生效）。额度不足不算限流，要快速失败。 */
function isRateLimit(failure) {
  if (!failure) return false
  if (failure.status === 429) return true
  return /rate.?limit|too.?many.?requests|\b429\b/i.test(`${failure.code || ''} ${failure.message || ''}`)
}

class BridgeUpstreamError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

/**
 * 起一个本地 OpenAI 兼容桥。
 * @param {object} ctx cordis 上下文（需已挂载 llm 服务）
 * @param {object} opts
 * @param {{provider:string,model:string,reasoningEffort?:string}} opts.route 已解析的模型路由
 * @param {number} [opts.timeoutMs] 单次请求超时，默认 600s（与 BabelDOC 的 httpx 超时对齐）
 * @returns {Promise<{baseUrl:string, token:string, port:number, model:string, close:()=>Promise<void>}>}
 */
export async function startLlmBridge(ctx, { route, timeoutMs = 600000 } = {}) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('LLM 桥需要宿主 llm 服务，但当前上下文没有挂载它。')

  const token = randomBytes(24).toString('hex')

  async function handleChat(body, signal) {
    const { system, messages } = splitMessages(body.messages)
    if (messages.length === 0) throw new BridgeUpstreamError('请求里没有用户消息', 400)

    const maxTokens = Number.isFinite(body.max_tokens) ? body.max_tokens : undefined
    const temperature = Number.isFinite(body.temperature) ? body.temperature : undefined

    const call = await llm.prepareCall(
      {
        provider: route.provider,
        model: route.model,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      },
      signal,
      (controls, model) => {
        // 显式指定了 effort 就尊重它；否则选最低档，落实「翻译关 thinking」
        if (controls.reasoningEffort !== undefined) return controls
        const lowest = model?.reasoning?.efforts?.[0]?.id
        return lowest === undefined ? controls : { ...controls, reasoningEffort: lowest }
      },
    )

    let content = ''
    let usage = null
    let finish = null
    for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
      if (chunk.type === 'text-delta') content += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }

    if (!finish) throw new BridgeUpstreamError('宿主模型没有返回结束信号', 502)
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const f = finish.failure || {}
      throw new BridgeUpstreamError(f.message || `宿主模型调用失败（${finish.kind}）`, isRateLimit(f) ? 429 : 502)
    }

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: route.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: toFinishReason(finish.kind) }],
      usage: toOpenAiUsage(usage),
    }
  }

  function sendJson(res, status, payload) {
    const data = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
    res.end(data)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > 8 * 1024 * 1024) {
          reject(new BridgeUpstreamError('请求体过大', 413))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0]
    // 鉴权：只认本进程随机 token，挡住同机其他进程的误用
    if (req.headers.authorization !== `Bearer ${token}`) {
      return sendJson(res, 401, { error: { message: 'invalid bridge token', type: 'invalid_request_error', code: 'invalid_api_key' } })
    }

    if (req.method === 'GET' && /\/models$/.test(url)) {
      return sendJson(res, 200, { object: 'list', data: [{ id: route.model, object: 'model', owned_by: 'dsh-llm-bridge' }] })
    }

    if (req.method === 'POST' && /\/chat\/completions$/.test(url)) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      // 只在客户端「提前」断开时取消上游调用。不能监听 req 的 close：
      // Node 的 IncomingMessage 在请求体读完（正常完成）时也会触发 close，
      // 那会在 llm 还在异步推理时就把调用 abort 掉（实测每次请求立刻 AbortError→502）。
      // 改用 res 的 close + writableFinished：响应已发完才算正常结束，否则才是提前断开。
      res.on('close', () => { if (!res.writableFinished) ac.abort() })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const payload = await handleChat(body, ac.signal)
        sendJson(res, 200, payload)
      } catch (error) {
        const status = error instanceof BridgeUpstreamError ? error.status : 502
        const message = error instanceof Error ? error.message : String(error)
        if (!res.headersSent) {
          sendJson(res, status, { error: { message, type: 'upstream_error', code: status === 429 ? 'rate_limit_exceeded' : 'bad_gateway' } })
        }
      } finally {
        clearTimeout(timer)
      }
      return
    }

    sendJson(res, 404, { error: { message: `unknown route ${req.method} ${url}`, type: 'invalid_request_error', code: 'not_found' } })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    token,
    port,
    model: route.model,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}