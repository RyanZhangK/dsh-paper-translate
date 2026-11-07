/**
 * lib/estimate.js —— 翻译前成本预估
 *
 * 数字全部来自实测（Generalized_ICP.pdf，8 页，deepseek-v4-flash）：
 *
 *   原生 BabelDOC（服务端默认开 thinking）
 *     Total 238099 / Prompt 44370 / Completion 193729
 *     其中术语提取 55832（Prompt 5790 / Completion 50042）
 *
 *   本插件默认参数（--openai-thinking disabled + 复用词表，实跑 43,553）
 *     翻译阶段 Prompt 34544 / Completion 9009，术语阶段跳过
 *
 *   术语阶段为什么关不掉：术语提取走独立的 term_extraction_translator，只接受
 *   openai_term_extraction_reasoning，不接受 thinking（babeldoc/main.py:530-540），
 *   所以只要还在抽取，那部分开销就照付。
 *
 * 估算是给人做决策用的，不是账单。所以固定返回 assumptions，
 * 让使用者知道每个数字是怎么来的、什么时候会偏。
 */
import { renderTable, fmtTokens } from './format.js'

/** 每页翻译阶段 prompt tokens（实测 8 页 34544 / 8，thinking 已关闭）。 */
const TRANSLATE_PROMPT_PER_PAGE = 34544 / 8
/** 每页翻译阶段 completion tokens（实测 8 页 9009 / 8，thinking 已关闭）。 */
const TRANSLATE_COMPLETION_PER_PAGE = 9009 / 8
/** 术语提取每页 prompt / completion（thinking 关不掉，仍是实测原值 5790 / 50042）。 */
const TERM_PROMPT_PER_PAGE = 5790 / 8
const TERM_COMPLETION_PER_PAGE = 50042 / 8

/** 未经优化的原生基线（8 页 238099），只用于在 assumptions 里说明节省幅度。 */
const NATIVE_TOTAL_8_PAGES = 238099

/**
 * 参考单价（元 / 百万 token）。DeepSeek 系模型价格会调整，
 * 这里只是默认值，调用方可通过 config 的 pricing 覆盖。
 */
export const DEFAULT_PRICING = {
  'deepseek-v4-flash': { input: 0.5, output: 2 },
  'deepseek-v4-pro': { input: 2, output: 8 },
  'deepseek-flash': { input: 0.5, output: 2 },
  default: { input: 1, output: 4 },
}

export function resolvePricing(model, pricing) {
  const table = { ...DEFAULT_PRICING, ...(pricing || {}) }
  return table[model] || table.default
}

/**
 * @param {object} opts
 * @param {number} opts.pages 页数
 * @param {string} [opts.model]
 * @param {boolean} [opts.hasGlossary] 是否已有可复用的领域术语表
 * @param {boolean} [opts.extractGlossary] 是否现场抽取术语（已按「有词表默认不抽」传值）
 * @param {object} [opts.pricing] 覆盖单价表
 * @returns {{tokens:{prompt:number,completion:number,total:number}, cost:number, currency:string, breakdown:object, assumptions:string[]}}
 */
export function estimateTranslation({ pages, model, hasGlossary = false, extractGlossary = true, pricing }) {
  const n = Math.max(1, Math.floor(Number(pages) || 1))
  const prompt = Math.round(n * TRANSLATE_PROMPT_PER_PAGE)
  const completion = Math.round(n * TRANSLATE_COMPLETION_PER_PAGE)
  const termUsed = extractGlossary
  const termPrompt = termUsed ? Math.round(n * TERM_PROMPT_PER_PAGE) : 0
  const termCompletion = termUsed ? Math.round(n * TERM_COMPLETION_PER_PAGE) : 0

  const totalPrompt = prompt + termPrompt
  const totalCompletion = completion + termCompletion
  const price = resolvePricing(model, pricing)
  const cost = (totalPrompt / 1e6) * price.input + (totalCompletion / 1e6) * price.output

  const nativeBaseline = (NATIVE_TOTAL_8_PAGES / 8) * n
  const savedRatio = 1 - (totalPrompt + totalCompletion) / nativeBaseline

  const assumptions = [
    '翻译阶段基线：Generalized_ICP.pdf（8 页）在 thinking 关闭后实测 prompt 34544 / completion 9009，按页均摊',
    `同样这 8 页用原生默认参数是 238099 tokens，本次预估相当于省掉约 ${(savedRatio * 100).toFixed(0)}%`,
    termUsed
      ? '术语阶段保留：BabelDOC 的术语提取走独立 translator，不接受 thinking 开关（babeldoc/main.py:530-540），这部分开销关不掉'
      : hasGlossary
        ? '术语阶段跳过：复用已有领域术语表，不再花 token 抽取'
        : '术语阶段关闭：用 --no-auto-extract-glossary',
    `单价参考：输入 ¥${price.input}/M、输出 ¥${price.output}/M（${model || 'default'}）`,
    '按页均摊对整篇比较准；只翻前几页试读时会高估，因为首页文字量通常少于平均页',
  ]

  return {
    tokens: { prompt: totalPrompt, completion: totalCompletion, total: totalPrompt + totalCompletion },
    cost: Number(cost.toFixed(4)),
    currency: 'CNY',
    breakdown: {
      pages: n,
      translate: { prompt, completion },
      termExtraction: termUsed ? { prompt: termPrompt, completion: termCompletion } : null,
    },
    assumptions,
  }
}

/** 把预估结果渲染成一小段人读文本（定宽对齐，见 lib/format.js）。 */
export function formatEstimate(est) {
  const { tokens, cost, currency, breakdown } = est
  // 一页只要几厘钱，toFixed(2) 会把它抹成 ¥0.00，看着像预估失败
  const costText = cost >= 1 ? cost.toFixed(2) : cost.toFixed(4)
  const rows = [
    [
      '预估',
      `${breakdown.pages} 页约 ${fmtTokens(tokens.total)} tokens（prompt ${fmtTokens(tokens.prompt)} + completion ${fmtTokens(tokens.completion)}）`,
    ],
    ['参考成本', `¥${costText} ${currency}`],
  ]
  if (!breakdown.termExtraction) {
    rows.push(['术语阶段', '跳过（复用已有术语表或已关闭抽取）'])
  }
  return renderTable(rows)
}
