/**
 * LLM 桥测试：用一个假的宿主 llm 服务（产出已知 StreamChunk）起真桥，
 * 再用 fetch 打真 HTTP，验证 OpenAI 协议形状、usage 映射、鉴权与错误码。
 * 不碰网络、不打钱、不依赖真实宿主。
 *
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startLlmBridge, resolveBridgeRoute, isLlmAvailable } from '../lib/llm-bridge.js'

/** 造一个只实现桥用到那几个方法的假 ctx。 */
function mockCtx({ chunks = [], providers, models, selection, capture } = {}) {
  const llm = {
    listProviders: () => providers ?? [{ id: 'p', name: 'P' }],
    listModels: async () => models ?? [{ id: 'm', name: 'M', provider: 'p' }],
    prepareCall: async (config, signal, configure) => {
      const proposed = { reasoningEffort: config.reasoningEffort }
      const model = { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
      const controls = configure ? configure(proposed, model) : proposed
      const finalConfig = { ...config, ...controls }
      if (capture) capture.config = finalConfig
      return {
        config: finalConfig,
        stream: async function* () {
          for (const c of chunks) yield c
        },
      }
    },
  }
  return {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel' && selection) return { currentSelection: () => selection }
      return undefined
    },
  }
}

const STOP_CHUNKS = [
  { type: 'text-delta', index: 0, text: '你' },
  { type: 'text-delta', index: 0, text: '好' },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

async function post(baseUrl, token, body) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

const CHAT_BODY = {
  model: 'm',
  messages: [
    { role: 'system', content: 'You are a translation engine.' },
    { role: 'user', content: 'translate: hello' },
  ],
}

test('isLlmAvailable 看 ctx.get(llm)', () => {
  assert.equal(isLlmAvailable(mockCtx()), true)
  assert.equal(isLlmAvailable({ get: () => undefined }), false)
})

test('resolveBridgeRoute 优先级：显式配置 > 默认模型 > 单 provider 自动', async () => {
  // 显式配置最高优先
  const explicit = await resolveBridgeRoute(mockCtx({ selection: { provider: 'd', model: 'dm' } }), { provider: 'x', model: 'xm' })
  assert.deepEqual(explicit, { provider: 'x', model: 'xm' })

  // 默认模型次之
  const fromDefault = await resolveBridgeRoute(mockCtx({ selection: { provider: 'd', model: 'dm' } }))
  assert.deepEqual(fromDefault, { provider: 'd', model: 'dm' })

  // 单 provider 自动取第一个模型
  const auto = await resolveBridgeRoute(mockCtx({ providers: [{ id: 'solo', name: 'S' }], models: [{ id: 'only', name: 'O', provider: 'solo' }] }))
  assert.deepEqual(auto, { provider: 'solo', model: 'only' })

  // 多 provider 又没默认 → 抛错并给出配置指引
  await assert.rejects(
    () => resolveBridgeRoute(mockCtx({ providers: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] })),
    /llmBridge\.provider/,
  )
})

test('桥把流式 chunk 聚合成非流式 OpenAI 响应，usage 补回缓存', async () => {
  const capture = {}
  const bridge = await startLlmBridge(mockCtx({ chunks: STOP_CHUNKS, capture }), { route: { provider: 'p', model: 'm' } })
  try {
    const res = await post(bridge.baseUrl, bridge.token, CHAT_BODY)
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.object, 'chat.completion')
    assert.equal(json.choices[0].message.content, '你好')
    assert.equal(json.choices[0].finish_reason, 'stop')
    // prompt = input(10) + cacheRead(3) + cacheWrite(0) = 13
    assert.deepEqual(json.usage, { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 })
    // 未显式指定 effort → 选最低档落实 thinking-off
    assert.equal(capture.config.reasoningEffort, 'low')
  } finally {
    await bridge.close()
  }
})

test('桥只认随机 token，缺/错 token 一律 401', async () => {
  const bridge = await startLlmBridge(mockCtx({ chunks: STOP_CHUNKS }), { route: { provider: 'p', model: 'm' } })
  try {
    assert.equal((await post(bridge.baseUrl, null, CHAT_BODY)).status, 401)
    assert.equal((await post(bridge.baseUrl, 'wrong-token', CHAT_BODY)).status, 401)
  } finally {
    await bridge.close()
  }
})

test('GET /v1/models 返回桥接模型', async () => {
  const bridge = await startLlmBridge(mockCtx({ chunks: STOP_CHUNKS }), { route: { provider: 'p', model: 'my-model' } })
  try {
    const res = await fetch(`${bridge.baseUrl}/models`, { headers: { Authorization: `Bearer ${bridge.token}` } })
    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.data[0].id, 'my-model')
  } finally {
    await bridge.close()
  }
})

test('宿主限流→429（供 BabelDOC 重试），额度不足→502（快速失败）', async () => {
  const rateBridge = await startLlmBridge(
    mockCtx({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { status: 429, message: 'rate limit' } } }] }),
    { route: { provider: 'p', model: 'm' } },
  )
  try {
    assert.equal((await post(rateBridge.baseUrl, rateBridge.token, CHAT_BODY)).status, 429)
  } finally {
    await rateBridge.close()
  }

  const quotaBridge = await startLlmBridge(
    mockCtx({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { status: 403, message: '用户额度不足' } } }] }),
    { route: { provider: 'p', model: 'm' } },
  )
  try {
    const res = await post(quotaBridge.baseUrl, quotaBridge.token, CHAT_BODY)
    assert.equal(res.status, 502, '额度不足不是限流，不该让 BabelDOC 重试 100 次')
    const json = await res.json()
    assert.match(json.error.message, /额度不足/, '根因消息要透传，供 detectApiErrors 识别')
  } finally {
    await quotaBridge.close()
  }
})

test('max-tokens 结束映射成 finish_reason=length', async () => {
  const bridge = await startLlmBridge(
    mockCtx({ chunks: [{ type: 'text-delta', index: 0, text: 'partial' }, { type: 'finish', reason: { kind: 'max-tokens' } }] }),
    { route: { provider: 'p', model: 'm' } },
  )
  try {
    const json = await (await post(bridge.baseUrl, bridge.token, CHAT_BODY)).json()
    assert.equal(json.choices[0].finish_reason, 'length')
  } finally {
    await bridge.close()
  }
})

test('异步上游 + 客户端 Connection:close：请求体读完的正常 close 不能 abort 掉仍在推理的调用', async () => {
  // 回归：Node 的 IncomingMessage 在请求体读完（正常完成）时也触发 close。
  // 旧实现 req.on('close', abort) 会在上游还在异步推理时立刻 abort → 每次请求 AbortError→502，
  // host 模式真实翻译全军覆没（BabelDOC/httpx 发完 body 即关连接，正好踩中）。
  // 这里上游故意延迟 60ms 模拟真实推理，客户端带 Connection:close，验证仍能拿到 200。
  const slowCtx = {
    get(name) {
      if (name !== 'llm') return undefined
      return {
        prepareCall: async (config) => ({
          config,
          stream: async function* () {
            await new Promise((r) => setTimeout(r, 60))
            yield { type: 'text-delta', index: 0, text: '译文' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }),
      }
    },
  }
  const bridge = await startLlmBridge(slowCtx, { route: { provider: 'p', model: 'm' } })
  try {
    const result = await new Promise((resolve, reject) => {
      const u = new URL(`${bridge.baseUrl}/chat/completions`)
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.token}`, Connection: 'close' },
        },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => resolve({ status: res.statusCode, body: data }))
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify(CHAT_BODY))
    })
    assert.equal(result.status, 200, '请求体读完的正常 close 不该把上游调用 abort 成 502')
    assert.equal(JSON.parse(result.body).choices[0].message.content, '译文')
  } finally {
    await bridge.close()
  }
})