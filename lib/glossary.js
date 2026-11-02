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
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const GLOSSARY_DIR = path.join(homedir(), '.local', 'share', 'dsh-paper-translate', 'glossary')

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
  return path.join(GLOSSARY_DIR, `${safeDomain(domain)}.csv`)
}

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
  const seen = new Set(existing.map((e) => e.source.trim().toLowerCase()))
  const added = []
  for (const row of incoming || []) {
    const source = String(row?.source ?? '').trim()
    const target = String(row?.target ?? '').trim()
    if (!source || !target) continue
    const key = source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    added.push({ source, target, tgtLng: String(row?.tgtLng ?? '') || langOut })
  }
  const merged = [...existing, ...added]
  await mkdir(GLOSSARY_DIR, { recursive: true })
  const file = glossaryPath(safe)
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, serializeCsv(merged), 'utf8')
  await rename(tmp, file)
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
