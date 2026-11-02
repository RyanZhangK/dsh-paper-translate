/**
 * lib/glossary.js —— 跨文档术语库
 *
 * BabelDOC 自己产出的 glossary.csv 是 `source,target,tgt_lng` 三列带表头
 * （babeldoc/glossary.py:124-188 用 csv.DictReader，要求 source/target 列存在，
 * tgt_lng 可选且会按目标语言过滤），所以这里严格照这个格式读写，
 * 保证插件写出来的文件能直接再喂回 --glossary-files。
 *
 * 存储位置：~/.local/share/dsh-paper-translate/glossary/<domain>.csv
 * 一个领域一个文件，同一领域跨论文复用，避免每次重新花 token 抽术语。
 */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * 术语库目录。支持用环境变量覆盖，测试才不会写到用户真实数据里。
 */
export function glossaryDir() {
  const override = process.env.DSH_PAPER_TRANSLATE_GLOSSARY_DIR
  return override
    ? path.resolve(override)
    : path.join(homedir(), '.local', 'share', 'dsh-paper-translate', 'glossary')
}

/** @deprecated 用 glossaryDir()，常量在测试注入时不会跟着变。 */
export const GLOSSARY_DIR = glossaryDir()

const HEADER = ['source', 'target', 'tgt_lng']

export class GlossaryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GlossaryError'
    this.code = code
  }
}

/** 领域名只允许字母数字和 ._-，避免 ../ 之类的路径穿越。 */
export function safeDomain(domain) {
  const d = String(domain || 'general').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(d)) {
    throw new GlossaryError(
      'BAD_DOMAIN',
      `领域名不合法：${domain}（只允许小写字母、数字、点、下划线、连字符，且以字母数字开头）`,
    )
  }
  return d
}

export function glossaryPath(domain) {
  return path.join(glossaryDir(), `${safeDomain(domain)}.csv`)
}

/**
 * 术语只在某个目标语言下成立：`ICP,迭代最近点,zh-CN` 对 en 目标毫无用处。
 * BabelDOC 的 Glossary.from_csv 会按 lang_out 过滤，这里判断「有没有可用的词表」
 * 必须用同一口径，否则会出现「说复用、实际全被过滤掉」的静默失效。
 */
export function filterForLang(entries, langOut) {
  if (!langOut) return entries
  return entries.filter((e) => !e.tgtLng || e.tgtLng.toLowerCase() === String(langOut).toLowerCase())
}

const normLang = (lang) => String(lang || '').trim().toLowerCase()

/** 最小可用的 RFC4180 解析：够处理术语里的逗号和引号，不引第三方依赖。 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += c
      i += 1
      continue
    }
    if (c === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (c === '\r') {
      i += 1
      continue
    }
    if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += c
    i += 1
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function csvEscape(value) {
  const s = String(value ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function serializeCsv(entries) {
  const lines = [HEADER.join(',')]
  for (const e of entries) {
    lines.push([csvEscape(e.source), csvEscape(e.target), csvEscape(e.tgtLng || '')].join(','))
  }
  return `${lines.join('\n')}\n`
}

/**
 * 读一个领域的术语表。文件不存在时返回空数组（不是错误）。
 * 表头缺失或列不对时抛 GlossaryError，避免把坏数据当真。
 */
export async function readGlossary(domain) {
  const file = glossaryPath(domain)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw new GlossaryError('GLOSSARY_READ_FAILED', `读不到术语表 ${file}：${error.message}`)
  }
  const rows = parseCsv(text.replace(/^\uFEFF/, ''))
  if (!rows.length) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const si = header.indexOf('source')
  const ti = header.indexOf('target')
  if (si < 0 || ti < 0) {
    throw new GlossaryError(
      'GLOSSARY_BAD_HEADER',
      `术语表 ${file} 缺少 source/target 表头，与 BabelDOC 的 CSV 格式不兼容`,
    )
  }
  const li = header.indexOf('tgt_lng')
  const out = []
  for (const row of rows.slice(1)) {
    const source = (row[si] || '').trim()
    const target = (row[ti] || '').trim()
    if (!source || !target) continue
    out.push({ source, target, tgtLng: li >= 0 ? (row[li] || '').trim() : '' })
  }
  return out
}

/**
 * 合并新术语进领域词表。
 * 规则：按 source 大小写不敏感去重，已存在的条目保留旧译文（术语一旦定下就别被后跑的论文改掉），
 * 因此行数只增不减。
 */
export async function mergeGlossary(domain, incoming, { langOut = 'zh-CN' } = {}) {
  const safe = safeDomain(domain)
  const existing = await readGlossary(safe)
  // 唯一键必须带目标语言：同一个词翻成 zh-CN 和 en 是两条独立记录，
  // 只按 source 去重会让第二种语言的新行被静默吞掉
  const keyOf = (source, target) => `${source.trim().toLowerCase()}\u0000${normLang(target) || normLang(langOut)}`
  const seen = new Set(existing.map((e) => keyOf(e.source, e.tgtLng)))
  const added = []
  for (const row of incoming || []) {
    const source = String(row?.source ?? '').trim()
    const target = String(row?.target ?? '').trim()
    if (!source || !target) continue
    const tgtLng = String(row?.tgtLng ?? '').trim() || langOut
    const key = keyOf(source, tgtLng)
    if (seen.has(key)) continue
    seen.add(key)
    added.push({ source, target, tgtLng })
  }
  const merged = [...existing, ...added]
  await mkdir(glossaryDir(), { recursive: true })
  const file = glossaryPath(safe)
  const tmp = `${file}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, serializeCsv(merged), 'utf8')
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
  return { domain: safe, path: file, added: added.length, total: merged.length }
}

export async function glossaryStats(domain) {
  const safe = safeDomain(domain)
  const entries = await readGlossary(safe)
  return { domain: safe, path: glossaryPath(safe), count: entries.length }
}

/**
 * 把 BabelDOC 本次产出的 glossary.csv（可能带 BOM、可能三列）读成条目数组。
 * 用于翻译结束后回填领域词表。
 */
export async function importBabeldocGlossary(csvPath) {
  const text = await readFile(csvPath, 'utf8')
  const rows = parseCsv(text.replace(/^\uFEFF/, ''))
  if (!rows.length) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const si = header.indexOf('source')
  const ti = header.indexOf('target')
  const li = header.indexOf('tgt_lng')
  if (si < 0 || ti < 0) return []
  const out = []
  for (const row of rows.slice(1)) {
    const source = (row[si] || '').trim()
    const target = (row[ti] || '').trim()
    if (!source || !target) continue
    out.push({ source, target, tgtLng: li >= 0 ? (row[li] || '').trim() : '' })
  }
  return out
}
