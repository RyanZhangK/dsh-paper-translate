/**
 * dsh-paper-translate —— 把 BabelDOC 包成一个 DSH 工具
 *
 * 它补的是「用一次就会痛」的三个点：
 *   1. BabelDOC 不会自己读 config.toml，必须显式 -c；
 *   2. 服务端默认偷偷开 thinking，completion 里七成以上是推理 token；
 *   3. 术语表本来可以跨论文复用，但默认每次都重新抽一遍。
 *
 * 依赖不代装：检查不过就把准确的修复命令交回给模型/用户。
 */
import path from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkEnvironment, formatProblems, buildHostConfigText } from './detect.js'
import { probePages, run, countPages, intOption, verifyTranslation } from './translate.js'
import { readGlossary, mergeGlossary, importBabeldocGlossary, glossaryPath, filterForLang } from './glossary.js'
import { estimateTranslation, formatEstimate } from './estimate.js'
import { table, fmtTokens } from './format.js'
import { isLlmAvailable, resolveBridgeRoute, startLlmBridge } from './llm-bridge.js'

const name = 'dsh-paper-translate'
const inject = ['tools']

/** 把 run() 捞到的 API 根因渲染成修复指引；没有就返回空数组。 */
function rootCauseLines(apiErrors) {
  if (!apiErrors || apiErrors.length === 0) return []
  return ['', '日志里识别到的 API 根因：', ...apiErrors.map((e) => `- [${e.code}] ${e.hint}`)]
}

function apply(ctx, config = {}) {
  ctx.tools.register(
    defineTool({
      name: 'paper_translate',
      description:
        '用 BabelDOC 把整篇 PDF 文献翻译成双语对照版。默认关闭服务端 thinking 推理（省约六成 completion token）、按领域复用术语表、并在执行前给出 token 与成本预估。dryRun=true 时只预估不动手。',
      parameters: {
        pdf: { type: 'string', required: true, description: 'PDF 文件的绝对路径' },
        langOut: { type: 'string', description: '目标语言代码，默认沿用 BabelDOC config 的 lang-out（通常 zh-CN）' },
        domain: { type: 'string', description: '术语库领域名（如 slam、rl、cv），同一领域的论文共用一份术语表，默认 general' },
        pages: { type: 'string', description: '只翻部分页，形如 "1-6" 或 "1,3,5-7"；不传则整篇' },
        extractGlossary: {
          type: 'boolean',
          description:
            '是否允许 BabelDOC 现场抽取术语。默认 true，但只有该领域还没有可用词表时才会真的抽——BabelDOC 一旦抽词就会把 --glossary-files 的用户词表整个丢弃，两者互斥。传 false 表示不抽词，只复用已有词表',
        },
        dryRun: { type: 'boolean', description: '只做环境检查与成本预估，不启动翻译' },
        ignoreCache: {
          type: 'boolean',
          description: '忽略 BabelDOC 的翻译缓存强制重翻。默认复用缓存，同一份 PDF 重跑是 0 token',
        },
        outputDir: { type: 'string', description: '输出目录，默认沿用 BabelDOC config 的 output' },
        api: {
          type: 'string',
          description:
            '翻译 API 来源：host=走 DSH 宿主模型（本地 LLM 桥，无需第三方 key，复用当前会话的模型与凭据）；config=用 BabelDOC config.toml 里的第三方 API；auto=宿主 llm 可用就走 host，否则回落 config。默认 auto',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        if (exec.signal?.aborted) return '已取消：调用在开始前就被中止。'

        // API 来源：host（DSH 宿主模型 / LLM 桥）、config（第三方 toml）、auto（默认）。
        // auto 在宿主 llm 可用时走 host，否则回落 config 并在输出里明示，不静默换路。
        const apiMode = args.api || 'auto'
        if (!['host', 'config', 'auto'].includes(apiMode)) {
          return `api 只能是 host / config / auto，收到的是「${apiMode}」。`
        }
        const hostAvailable = isLlmAvailable(ctx)
        if (apiMode === 'host' && !hostAvailable) {
          return '请求 api: "host"，但当前 DSH 上下文没有挂载 llm 服务，无法起 LLM 桥。请改用 api: "config" 并配置 BabelDOC config.toml，或确认宿主已启用模型服务。'
        }
        const useHost = apiMode === 'host' || (apiMode === 'auto' && hostAvailable)

        const env = await checkEnvironment({
          configPath: config.configPath,
          babeldocBin: config.babeldocBin,
          pythonBin: config.pythonBin,
          // host 模式下 config.toml 可选：API 字段由桥现场合成
          hostMode: useHost,
          // dryRun 是「先看看能不能跑」，这时候值得多打一次 /models 探活；
          // 真翻译时不用，翻译自己就会暴露连不通的问题。host 模式不探第三方 key。
          probe: args.dryRun === true && !useHost,
        })
        if (!env.ok) {
          return [
            '环境未就绪，先修好下面这些问题再翻译：',
            formatProblems(env.problems),
          ].join('\n')
        }

        // 工具进程的 cwd 与用户 shell 的 cwd 不是一回事，相对路径会静默解析到别处
        if (!path.isAbsolute(args.pdf)) {
          return `pdf 需要绝对路径，收到的是「${args.pdf}」。工具进程的工作目录不是你的 shell 目录，相对路径会解析到别的地方去。`
        }
        const pdf = path.resolve(args.pdf)
        const totalPages = await probePages(pdf, env.pythonBin)
        if (!totalPages) return `读不出页数：${pdf}（确认它是有效的 PDF，且 babeldoc 的 python 或 pdfinfo 可用）`

        const domain = args.domain || 'general'
        const langOut = args.langOut || env.config.langOut
        const outputDir = args.outputDir || env.config.outputDir
        const planned = countPages(args.pages, totalPages)

        // host 模式先把模型路由定下来（只读配置，不起桥），dryRun 的预估也要用它
        let route = null
        if (useHost) {
          try {
            route = await resolveBridgeRoute(ctx, config.llmBridge || {})
          } catch (error) {
            return `LLM 桥无法确定翻译模型：${error.message}`
          }
        }
        const displayModel = useHost ? route.model : env.config.model
        const apiLabel = useHost
          ? 'DSH 宿主模型（LLM 桥）'
          : apiMode === 'auto'
            ? 'config.toml 第三方（宿主 llm 不可用，已回落）'
            : 'config.toml 第三方'

        let existing = []
        try {
          existing = await readGlossary(domain)
        } catch (error) {
          return `读术语表失败：${error.message}`
        }
        // 先按目标语言过滤再判断「有没有可用词条」：BabelDOC 的 Glossary.from_csv 会按
        // lang_out 把别的语言的术语整行扔掉，不提前过滤就会「说 N 条可复用、实际一条没用上」
        const usableGlossary = filterForLang(existing, langOut)
        const hasGlossary = usableGlossary.length > 0
        const glossaryFile = hasGlossary ? glossaryPath(domain) : undefined

        // BabelDOC 的 get_glossaries_for_translation() 在自动抽取开启且抽到词表时
        // 直接 return auto_extracted_glossary，把 --glossary-files 里的用户词表整个丢掉。
        // 所以「复用词表」和「现场抽取」是互斥的，不能既要又要。
        const willExtract = !hasGlossary && args.extractGlossary !== false

        const est = estimateTranslation({
          pages: planned,
          model: displayModel,
          hasGlossary,
          extractGlossary: willExtract,
          pricing: config.pricing,
        })

        // 路径可能很长，单独一行不截断；其余短字段走定宽表格，避免中英混排错位
        const head = [
          `PDF：${pdf}`,
          ...table([
            ['页数', `${totalPages} 页（本次处理 ${planned} 页）`],
            ['API', apiLabel],
            ['模型', displayModel],
            ['目标语言', langOut],
            [
              '术语表',
              hasGlossary
                ? `${domain}（可复用 ${usableGlossary.length} 条，本次不再重抽术语）`
                : `${domain}（暂无可用词条，${willExtract ? '将现场抽取并回填' : '已关闭抽取'}）`,
            ],
          ]),
        ]

        if (args.dryRun) {
          return [...head, '', formatEstimate(est), '', '依据：', ...est.assumptions.map((a) => `- ${a}`)].join('\n')
        }

        // host 模式：起本地 LLM 桥 + 合成临时 config.toml（只含桥的 API 字段与用户非 API 偏好，
        // 绝不抄用户第三方 key）。桥与临时文件都是本次调用私有，跑完即清理。
        let bridge = null
        let hostConfigDir = null
        let releaseEffect = null
        if (useHost) {
          try {
            bridge = await startLlmBridge(ctx, { route })
            hostConfigDir = await mkdtemp(path.join(tmpdir(), 'dpt-host-'))
            const hostConfigPath = path.join(hostConfigDir, 'config.toml')
            await writeFile(
              hostConfigPath,
              buildHostConfigText(env.config, {
                baseUrl: bridge.baseUrl,
                token: bridge.token,
                model: route.model,
                outputDir,
                langOut,
              }),
              { encoding: 'utf8', mode: 0o600 },
            )
            // 安全网：fiber 若在翻译中途卸载，ctx.effect 的 disposer 也会关桥。
            // 正常路径在 finally 里主动 release（既关桥又注销 effect，避免逐次累积）。
            if (typeof ctx.effect === 'function') {
              try {
                releaseEffect = ctx.effect(() => () => bridge.close(), 'paper-translate:llm-bridge')
              } catch {
                releaseEffect = null
              }
            }
          } catch (error) {
            if (bridge) await bridge.close().catch(() => {})
            if (hostConfigDir) await rm(hostConfigDir, { recursive: true, force: true }).catch(() => {})
            return `LLM 桥启动失败：${error.message}`
          }
        }

        let result
        try {
          result = await run({
            pdf,
            // host 模式用合成的临时 config；config 模式沿用 detect 归一化出的 configPath
            configPath: useHost ? path.join(hostConfigDir, 'config.toml') : env.config.configPath,
            babeldocBin: env.babeldocBin,
            outputDir,
            langOut,
            thinking: 'disabled',
            glossaryFile,
            extractGlossary: willExtract,
            ignoreCache: args.ignoreCache === true,
            pages: args.pages,
            watermarkMode: 'no_watermark',
            dual: true,
            poolWorkers: intOption(config.poolWorkers, 2),
            termPoolWorkers: intOption(config.termPoolWorkers, 2),
            signal: exec.signal,
          })
        } finally {
          // 无论成功/失败/中止都收桥删临时文件。releaseEffect 会触发关桥并注销 effect；
          // 没注册成 effect 时直接关桥。
          try {
            if (releaseEffect) await releaseEffect()
            else if (bridge) await bridge.close()
          } catch {
            /* 关闭失败不影响结果报账 */
          }
          if (hostConfigDir) await rm(hostConfigDir, { recursive: true, force: true }).catch(() => {})
        }

        if (!result.ok) {
          const tail = result.logTail.split('\n').slice(-15).join('\n')
          return [
            ...head,
            '',
            result.signalAborted ? '翻译被中止。' : `翻译失败（退出码 ${result.code}）。`,
            ...rootCauseLines(result.apiErrors),
            '',
            '日志尾部：',
            '```',
            tail,
            '```',
            '',
            '常见原因：账户并发上限（低余额时是 3，可把 poolWorkers 调到 1-2）、PDF 解析异常（试试 BabelDOC 的 --enhance-compatibility）、API key 或模型名不对。',
          ].join('\n')
        }

        if (!result.outputs.existing.dual && !result.outputs.existing.mono) {
          return [
            ...head,
            '',
            '翻译进程退出了，但预期产物不存在：',
            `  ${result.outputs.dual}`,
            '确认 outputDir 可写、BabelDOC 版本命名规则是否变了（当前认两套：<stem>[.no_watermark].<lang>.{dual,mono}.pdf，分片合并不带段、单篇带段）。',
            '',
            '日志尾部：',
            '```',
            result.logTail.split('\n').slice(-10).join('\n'),
            '```',
          ].join('\n')
        }

        // 内容验收：退出码 0 ≠ 翻译成功。API 全部失败时 BabelDOC 会原样输出原文副本，
        // 只有数译文里的 CJK 字符才能识破（0.1.1 在这里把英文副本当成功报了出去）。
        const verifyTarget = result.outputs.existing.dual ? result.outputs.dual : result.outputs.mono
        const verify = await verifyTranslation(verifyTarget, langOut, env.pythonBin)
        if (verify.checked && !verify.ok) {
          return [
            ...head,
            '',
            `翻译失败：产物里没有 ${langOut} 译文内容（抽样 ${verify.sampledPages}/${verify.totalPages} 页，仅 ${verify.cjkCount} 个中日文字符）。`,
            'BabelDOC 在 API 调用全部失败时仍会退出码 0 并原样输出原文——这份文件是英文副本，不是译文。',
            ...rootCauseLines(result.apiErrors),
            '',
            '日志尾部：',
            '```',
            result.logTail.split('\n').slice(-15).join('\n'),
            '```',
          ].join('\n')
        }

        const usage = result.usage
        const lines = [
          ...head,
          '',
          `双语版：${result.outputs.dual}`,
          `单语版：${result.outputs.mono}`,
          '',
        ]
        if (verify.checked) {
          lines.push(`内容验收：通过（抽样 ${verify.sampledPages}/${verify.totalPages} 页，${verify.cjkCount} 个中日文字符）`)
        } else {
          lines.push(`内容验收：未执行（${verify.reason}）`)
        }
        lines.push('')
        if (!usage.parsed) {
          // 一个统计字段都没匹配到：要么日志格式变了，要么这版 BabelDOC 输出方式不同。
          // 不能把这种情况说成「0 token 缓存命中」——钱可能已经花了。
          lines.push(
            '实际用量：解析失败',
            '  日志里没有找到 token 统计行，BabelDOC 的日志格式可能变了。译文已生成，但用量未知，请直接看 BabelDOC 的原始输出。',
          )
        } else if (usage.total === 0) {
          lines.push(
            '实际用量：0 tokens —— 命中 BabelDOC 本地翻译缓存',
            '  本次没有产生 API 调用。要强制重翻请传 ignoreCache: true。',
          )
        } else {
          const usageRows = [
            ['实际用量', `${fmtTokens(usage.total)} tokens`],
            ['prompt', fmtTokens(usage.prompt)],
            ['completion', fmtTokens(usage.completion)],
            ['预估用量', `${fmtTokens(est.tokens.total)} tokens`],
          ]
          if (est.tokens.total > 0) {
            const deviation = ((usage.total - est.tokens.total) / est.tokens.total) * 100
            usageRows.push(['预估偏差', `${deviation >= 0 ? '+' : ''}${deviation.toFixed(1)}%`])
          }
          if (usage.termExtraction && usage.termExtraction.total > 0) {
            usageRows.push([
              '术语提取',
              `${fmtTokens(usage.termExtraction.total)} tokens（不受 thinking 开关控制）`,
            ])
          }
          lines.push(...table(usageRows))
        }

        lines.push('')

        // 把本次产出的术语回填进领域词表，下次同领域直接复用。
        // 只有真的跑了抽取才回填：未抽词时 output 目录里可能躺着上一次留下的同名
        // .glossary.csv，照读会把陈年旧词当成「本次新增」。
        if (willExtract && result.outputs.existing.glossary) {
          try {
            const rows = await importBabeldocGlossary(result.outputs.glossary)
            const merged = await mergeGlossary(domain, rows, { langOut })
            lines.push(
              hasGlossary
                ? `术语表 ${domain}：${existing.length} → ${merged.total} 条（新增 ${merged.added}）`
                : `术语表 ${domain}：新建 ${merged.total} 条`,
            )
          } catch (error) {
            lines.push(`术语表回填失败：${error.message}（译文不受影响）`)
          }
        } else if (hasGlossary) {
          lines.push(`术语表 ${domain}：本次沿用 ${existing.length} 条，无新增`)
        }

        return lines.join('\n')
      },
    }),
  )
}

export { apply, inject, name }
