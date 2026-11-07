/**
 * lib/format.js —— 定宽文本表格（按显示列对齐，超宽截断）
 *
 * 为什么不用 \t：
 *   1. TAB 只跳到下一个制表位，终端默认 8、可配 4，重定向到文件或被别的渲染器
 *      接管后位置全变，根本没有「列」的概念；
 *   2. 中文占 2 个显示列却只算 1 个码点，按 String.length 补空格永远差一半；
 *   3. ANSI 颜色码宽 0 但占字节，一旦按字节补齐整行就歪。
 *
 * 这里的做法（定宽档）：
 *   - 总宽固定，列宽 = 总宽 - 标签列 - 间隔，不会因为某一行变长而整体错位；
 *   - 每一格先按显示宽度截断（超出补 …），再补空格到列宽；
 *   - 行尾不留空格，避免终端选区拖出一条尾巴。
 *
 * 数字一律用 fmtTokens() 输出，不用 toLocaleString()：后者在 de/ru 等 locale 下
 * 会给出 43.542，分组符一变宽度又变了。
 */

/** 默认总宽。72 列在常见终端与 Web 卡片里都不会折行。 */
export const DEFAULT_WIDTH = 72

/** 标签列与数值列之间的间隔。 */
const DEFAULT_GAP = 2

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g
/** 组合符、零宽字符：不占列。 */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]|\p{Mn}|\p{Me}/u
/** 东亚宽字符与 emoji：占 2 列。 */
const WIDE_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u

/** 去掉 ANSI 转义序列（本项目的输出不带颜色，防御性保留）。 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '')
}

/** 单个字符占几个显示列。 */
function charWidth(ch) {
  if (ZERO_WIDTH_RE.test(ch)) return 0
  if (WIDE_RE.test(ch)) return 2
  return 1
}

/** 字符串在等宽终端里占几列。 */
export function displayWidth(text) {
  let width = 0
  for (const ch of stripAnsi(text)) width += charWidth(ch)
  return width
}

/**
 * 按显示宽度截断，超出部分以 … 收尾。返回值长度不超过 width，不带尾部空格。
 * width <= 0 时返回空串。
 */
export function truncate(text, width) {
  const plain = stripAnsi(text).replace(/\s+/g, ' ')
  if (width <= 0) return ''
  if (displayWidth(plain) <= width) return plain
  let out = ''
  let used = 0
  // 留一列给省略号，所以是 width - 1
  for (const ch of plain) {
    const w = charWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

/** 截断后补齐到恰好 width 列。 */
export function padCell(text, width, align = 'left') {
  const cell = truncate(text, width)
  const gap = width - displayWidth(cell)
  if (gap <= 0) return cell
  return align === 'right' ? ' '.repeat(gap) + cell : cell + ' '.repeat(gap)
}

/**
 * 渲染一张定宽两列表格。
 *
 * @param {Array<[string, string]|{label: string, value: string}>} rows
 * @param {object} [opts]
 * @param {number} [opts.width] 总宽，默认 72
 * @param {number} [opts.gap] 标签列与数值列之间的空格数，默认 2
 * @param {number} [opts.labelWidth] 强制标签列宽度，默认取最长标签
 * @returns {string[]} 每一行一条，行尾无空格
 */
export function table(rows, opts = {}) {
  const { width = DEFAULT_WIDTH, gap = DEFAULT_GAP, labelWidth } = opts
  const normalized = (rows || []).map((row) => {
    const [label, value] = Array.isArray(row) ? row : [row?.label, row?.value]
    return [String(label ?? ''), String(value ?? '')]
  })
  if (normalized.length === 0) return []

  const labelCol = Math.max(0, ...normalized.map(([label]) => displayWidth(label)))
  const desiredLabel = labelWidth === undefined ? labelCol : labelWidth
  // 标签本身比总宽还长时也要截断，否则整行必然超宽，对齐就整体崩了
  const effectiveLabel = Math.max(1, Math.min(desiredLabel, width - gap - 8))
  // 至少留 8 列给数值，否则总宽给太小时会挤成一条
  const valueCol = Math.max(8, width - effectiveLabel - gap)

  return normalized.map(([label, value]) => {
    const left = padCell(label, effectiveLabel)
    const right = padCell(value, valueCol)
    return `${left}${' '.repeat(gap)}${right}`.replace(/\s+$/, '')
  })
}

/** table() 的便捷版：直接拼成多行字符串。 */
export function renderTable(rows, opts) {
  return table(rows, opts).join('\n')
}

/** 千分位，和 locale 无关。 */
export function fmtTokens(value) {
  const n = Math.round(Number(value) || 0)
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
