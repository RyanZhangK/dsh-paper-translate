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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkEnvironment, formatProblems } from './detect.js'
import { probePages, run } from './translate.js'
import { readGlossary, mergeGlossary, importBabeldocGlossary, glossaryPath } from './glossary.js'
import { estimateTranslation, formatEstimate } from './estimate.js'

const name = 'dsh-paper-translate'
const inject = ['tools']

/** 把 "1-6" / "1,3,5-7" 这类页码规格换算成页数；算不出就返回 null。 */
function countPages(spec, total) {
  if (!spec || !total) return total || null
  let count = 0
  for (const part of String(spec).split(',')) {
    const s = part.trim()
    if (!s) continue
    const range = /^(\d+)\s*-\s*(\d*)$/.exec(s)
    if (range) {
      const from = Number(range[1])
      const to = range[2] ? Number(range[2]) : total
      if (to >= from) count += to - from + 1
      continue
    }
    if (/^\d+$/.test(s)) count += 1
  }
  return count > 0 ? count : total
}

function pct(actual, baseline) {
  if (!baseline) return ''
  const ratio = (actual / baseline) * 100
  return `${ratio.toFixed(1)}%（省 ${(100 - ratio).toFixed(1)}%）`
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
          description: '没有可用术语表时是否允许 BabelDOC 现场抽取术语。默认 true；关掉可再省约 23% token，代价是术语一致性变差',
        },
        dryRun: { type: 'boolean', description: '只做环境检查与成本预估，不启动翻译' },
        ignoreCache: {
          type: 'boolean',
          description: '忽略 BabelDOC 的翻译缓存强制重翻。默认复用缓存，同一份 PDF 重跑是 0 token',
        },
        outputDir: { type: 'string', description: '输出目录，默认沿用 BabelDOC config 的 output' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        if (exec.signal?.aborted) return '已取消：调用在开始前就被中止。'

        const env = await checkEnvironment({
          configPath: config.configPath,
          babeldocBin: config.babeldocBin,
          pythonBin: config.pythonBin,
        })
        if (!env.ok) {
          return [
            '环境未就绪，先修好下面这些问题再翻译：',
            formatProblems(env.problems),
          ].join('\n')
        }

        const pdf = path.resolve(args.pdf)
        const totalPages = await probePages(pdf, env.pythonBin)
        if (!totalPages) return `读不出页数：${pdf}（确认它是有效的 PDF，且 babeldoc 的 python 或 pdfinfo 可用）`

        const domain = args.domain || 'general'
        const langOut = args.langOut || env.config.langOut
        const outputDir = args.outputDir || env.config.outputDir
        const planned = countPages(args.pages, totalPages)

        let existing = []
        try {
          existing = await readGlossary(domain)
        } catch (error) {
          return `读术语表失败：${error.message}`
        }
        const hasGlossary = existing.length > 0
        const glossaryFile = hasGlossary ? glossaryPath(domain) : undefined

        // 有词表就默认不再抽（术语阶段直接省掉）；显式 extractGlossary: true 才在
        // 复用词表的同时继续补新词——那是花钱换术语覆盖率，得由调用方明确要求
        const willExtract =
          args.extractGlossary === true ? true : args.extractGlossary === false ? false : !hasGlossary

        const est = estimateTranslation({
          pages: planned,
          model: env.config.model,
          hasGlossary,
          extractGlossary: willExtract,
        })

        const head = [
          `PDF：${pdf}`,
          `共 ${totalPages} 页，本次处理 ${planned} 页；模型 ${env.config.model}；目标语言 ${langOut}`,
          hasGlossary
            ? `术语表：${domain}（已有 ${existing.length} 条，直接复用；${willExtract ? '同时继续补新词' : '不再重抽术语'}）`
            : `术语表：${domain}（暂无，${willExtract ? '将现场抽取并回填' : '已关闭抽取'}）`,
        ]

        if (args.dryRun) {
          return [...head, '', formatEstimate(est), '', '依据：', ...est.assumptions.map((a) => `- ${a}`)].join('\n')
        }

        const result = await run({
          pdf,
          configPath: env.configPath || env.config.configPath,
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
          poolWorkers: Number(config.poolWorkers) || 2,
          termPoolWorkers: Number(config.termPoolWorkers) || 2,
          signal: exec.signal,
        })

        if (!result.ok) {
          const tail = result.logTail.split('\n').slice(-15).join('\n')
          return [
            ...head,
            '',
            result.signalAborted ? '翻译被中止。' : `翻译失败（退出码 ${result.code}）。`,
            '日志尾部：',
            '```',
            tail,
            '```',
            '',
            '常见原因：账户并发上限（低余额时是 3，可把 poolWorkers 调到 1-2）、PDF 解析异常（试试 BabelDOC 的 --enhance-compatibility）、API key 或模型名不对。',
          ].join('\n')
        }

        const usage = result.usage
        const lines = [
          ...head,
          '',
          `完成：${result.outputs.dual}`,
          `单语版：${result.outputs.mono}`,
          '',
        ]
        if (usage.total === 0) {
          lines.push(
            '实际用量：0 tokens —— 本次全部命中 BabelDOC 的本地翻译缓存，没有产生 API 调用。要强制重翻请传 ignoreCache: true。',
          )
        } else {
          lines.push(
            `实际用量：${usage.total.toLocaleString()} tokens（prompt ${usage.prompt.toLocaleString()} / completion ${usage.completion.toLocaleString()}）`,
            `预估用量：${est.tokens.total.toLocaleString()} tokens`,
          )
          if (est.tokens.total > 0) {
            const deviation = ((usage.total - est.tokens.total) / est.tokens.total) * 100
            lines.push(`预估偏差：${deviation >= 0 ? '+' : ''}${deviation.toFixed(1)}%`)
          }
          if (usage.termExtraction && usage.termExtraction.total > 0) {
            lines.push(
              `其中术语提取：${usage.termExtraction.total.toLocaleString()} tokens（这部分不受 thinking 开关控制）`,
            )
          }
        }

        // 把本次产出的术语回填进领域词表，下次同领域直接复用
        if (result.outputs.existing.glossary) {
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
