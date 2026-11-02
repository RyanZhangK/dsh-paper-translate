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
import { readGlossary, mergeGlossary, importBabeldocGlossary, glossaryPath, filterForLang } from './glossary.js'
import { estimateTranslation, formatEstimate } from './estimate.js'

const name = 'dsh-paper-translate'
const inject = ['tools']

/**
 * 把 babeldoc 的 --pages 规格换算成实际页数。
 * babeldoc 自己支持 "1,2,1-,-3,3-5" 这种写法（含开放区间），这里必须同口径：
 * 裁剪到总页数、去重、忽略 0 和越界页。算不一致的话，成本预估与偏差百分比会一起失真。
 */
export function countPages(spec, total) {
  if (!spec) return total || null
  if (!total) return null
  const picked = new Set()
  for (const part of String(spec).split(',')) {
    const s = part.trim()
    if (!s) continue
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(s)
    if (m) {
      const from = Math.max(1, m[1] ? Number(m[1]) : 1)
      const to = Math.min(total, m[2] ? Number(m[2]) : total)
      for (let p = from; p <= to; p++) picked.add(p)
      continue
    }
    if (/^\d+$/.test(s)) {
      const p = Number(s)
      if (p >= 1 && p <= total) picked.add(p)
    }
  }
  return picked.size || total
}

/**
 * 只接受正整数。`Number(x) || 2` 会把显式的 0 静默变成 2，而 0 往往是用户
 * 想表达「别开并发」——要么明确报错，要么按老默认走，不该悄悄改值。
 */
function intOption(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
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
          // dryRun 是「先看看能不能跑」，这时候值得多打一次 /models 探活；
          // 真翻译时不用，翻译自己就会暴露连不通的问题
          probe: args.dryRun === true,
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
          model: env.config.model,
          hasGlossary,
          extractGlossary: willExtract,
          pricing: config.pricing,
        })

        const head = [
          `PDF：${pdf}`,
          `共 ${totalPages} 页，本次处理 ${planned} 页；模型 ${env.config.model}；目标语言 ${langOut}`,
          hasGlossary
            ? `术语表：${domain}（可复用 ${usableGlossary.length} 条，本次不再重抽术语）`
            : `术语表：${domain}（暂无可用词条，${willExtract ? '将现场抽取并回填' : '已关闭抽取'}）`,
        ]

        if (args.dryRun) {
          return [...head, '', formatEstimate(est), '', '依据：', ...est.assumptions.map((a) => `- ${a}`)].join('\n')
        }

        const result = await run({
          pdf,
          // detect 把归一化后的配置放在 env.config 里，configPath 也在其中
          configPath: env.config.configPath,
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

        if (!result.outputs.existing.dual && !result.outputs.existing.mono) {
          return [
            ...head,
            '',
            '翻译进程退出了，但预期产物不存在：',
            `  ${result.outputs.dual}`,
            '确认 outputDir 可写、BabelDOC 版本命名规则是否变了（当前按 <stem>.no_watermark.<lang>.{dual,mono}.pdf 推断）。',
            '',
            '日志尾部：',
            '```',
            result.logTail.split('\n').slice(-10).join('\n'),
            '```',
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
        if (!usage.parsed) {
          // 一个统计字段都没匹配到：要么日志格式变了，要么这版 BabelDOC 输出方式不同。
          // 不能把这种情况说成「0 token 缓存命中」——钱可能已经花了。
          lines.push(
            '实际用量：解析失败 —— 日志里没有找到 token 统计行，BabelDOC 的日志格式可能变了。译文已生成，但用量未知，请直接看 BabelDOC 的原始输出。',
          )
        } else if (usage.total === 0) {
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
