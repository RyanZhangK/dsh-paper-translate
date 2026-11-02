/**
 * lib/translate.js —— BabelDOC 调用编排
 *
 * 这一层只做三件事：
 *   1. 把参数拼对（尤其是 -c 和 --openai-thinking disabled，前者不传 BabelDOC 会直接
 *      报「必须选择一个翻译服务」，后者是省 token 的关键）；
 *   2. 把术语表状态翻译成 --glossary-files / --no-auto-extract-glossary；
 *   3. 跑子进程、实时解析日志里的用量，结束时报账。
 *
 * 不在这里做环境检查，调用方先跑 detect.checkEnvironment()。
 */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const LOG_TAIL_LINES = 60

/** 用 babeldoc 自带的 python 数字页；失败退到 pdfinfo；都失败返回 null。 */
export async function probePages(pdfPath, pythonBin) {
  if (pythonBin) {
    try {
      const { stdout } = await execFileAsync(
        pythonBin,
        ['-c', 'import fitz,sys;d=fitz.open(sys.argv[1]);print(d.page_count)', pdfPath],
        { timeout: 30000 },
      )
      const n = Number(stdout.trim())
      if (Number.isFinite(n) && n > 0) return n
    } catch {
      /* 落到 pdfinfo */
    }
  }
  try {
    const { stdout } = await execFileAsync('pdfinfo', [pdfPath], { timeout: 20000 })
    const m = /^Pages:\s+(\d+)/m.exec(stdout)
    if (m) return Number(m[1])
  } catch {
    /* 放弃 */
  }
  return null
}

export async function fileExists(p) {
  try {
    await access(p, FS.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 拼 BabelDOC 命令行。
 * @param {object} o
 * @param {string} o.pdf 绝对路径
 * @param {string} o.configPath
 * @param {string} [o.outputDir]
 * @param {string} [o.langOut]
 * @param {'enabled'|'disabled'|'auto'} [o.thinking] auto = 不传该参数（BabelDOC 默认）
 * @param {string} [o.glossaryFile] 已存在的领域术语表
 * @param {boolean} [o.extractGlossary] 没有术语表时是否允许现场抽取
 * @param {number} [o.poolWorkers]
 * @param {number} [o.termPoolWorkers]
 * @param {string} [o.pages] 形如 "1-6"
 * @param {boolean} [o.dual] 是否输出交替双页版（默认 true）
 * @param {string} [o.watermarkMode]
 */
export function buildArgs(o) {
  const args = ['--config', o.configPath, '--files', o.pdf]
  if (o.outputDir) args.push('--output', o.outputDir)
  if (o.langOut) args.push('--lang-out', o.langOut)
  if (o.pages) args.push('--pages', String(o.pages))
  if (o.thinking && o.thinking !== 'auto') args.push('--openai-thinking', o.thinking)
  if (o.dual !== false) args.push('--use-alternating-pages-dual')
  if (o.watermarkMode) args.push('--watermark-output-mode', o.watermarkMode)
  if (o.maxPagesPerPart) args.push('--max-pages-per-part', String(o.maxPagesPerPart))
  if (o.poolWorkers) args.push('--pool-max-workers', String(o.poolWorkers))
  if (o.termPoolWorkers) args.push('--term-pool-max-workers', String(o.termPoolWorkers))

  if (o.glossaryFile) {
    // 有词表就复用，同时保留自动抽取：新术语还能补进词库
    args.push('--glossary-files', o.glossaryFile)
    if (o.extractGlossary === false) args.push('--no-auto-extract-glossary')
  } else if (o.extractGlossary === false) {
    args.push('--no-auto-extract-glossary')
  }
  // --save-auto-extracted-glossary 是 store_true 且默认 False（babeldoc/main.py:321-324），
  // 不显式加就是「抽了术语但不落盘」，术语库永远建不起来
  if (o.extractGlossary !== false) args.push('--save-auto-extracted-glossary')
  // BabelDOC 默认复用上一次的翻译缓存，同一份 PDF 再跑一次是 0 token；
  // 想强制重翻（比如换了术语表或模型）就传 ignoreCache
  if (o.ignoreCache) args.push('--ignore-cache')
  return args
}

/** BabelDOC 的产物命名规则：<stem>.no_watermark.<langOut>.{dual,mono}.pdf */
export function predictOutputs(pdf, outputDir, langOut, watermarkMode) {
  const stem = path.basename(pdf, path.extname(pdf))
  const dir = outputDir || path.dirname(pdf)
  const tag = (watermarkMode || 'no_watermark').replace(/_/g, '_')
  return {
    dir,
    dual: path.join(dir, `${stem}.${tag}.${langOut}.dual.pdf`),
    mono: path.join(dir, `${stem}.${tag}.${langOut}.mono.pdf`),
    glossary: path.join(dir, `${stem}.${tag}.${langOut}.glossary.csv`),
  }
}

/**
 * BabelDOC 的日志走 rich，长行会折行：
 *   INFO  INFO:babeldoc.main:Completion tokens:   main.py:774
 *         2381
 * 所以匹配前先去掉 ANSI、源码位置标记（xxx.py:123）和换行，把被拆开的数字接回去。
 */
function normalizeLog(text) {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .replace(/[A-Za-z_./\\-]+\.py:\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,，])/g, '$1')
}

export function parseUsage(text, usage) {
  const t = normalizeLog(text)
  const take = (re, key) => {
    let m
    const rx = new RegExp(re, 'g')
    while ((m = rx.exec(t)) !== null) usage[key] = Number(m[1])
  }
  take('Total tokens:\\s*(\\d+)', 'total')
  take('Prompt tokens:\\s*(\\d+)', 'prompt')
  take('Completion tokens:\\s*(\\d+)', 'completion')
  take('Cache hit prompt tokens:\\s*(\\d+)', 'cacheHitPrompt')

  const term = /Term extraction tokens:\s*total=(\d+)\s*prompt=(\d+)\s*completion=(\d+)(?:\s*cache_hit_prompt=(\d+))?/.exec(t)
  if (term) {
    usage.termExtraction = {
      total: Number(term[1]),
      prompt: Number(term[2]),
      completion: Number(term[3]),
      cacheHitPrompt: term[4] ? Number(term[4]) : 0,
    }
  }
  return usage
}

/** 从日志里挑出阶段进度，给工具层做「跑到哪了」的反馈。 */
function parseProgress(line) {
  const m = /(\d{1,3})%\s*\|/.exec(line) || /(\d{1,3})%\s*\|\s*([^|]+)/.exec(line)
  if (!m) return null
  const percent = Number(m[1])
  const stage = m[2] ? m[2].trim() : ''
  return { percent, stage }
}

/**
 * 跑一次翻译。
 * @param {object} o
 * @param {string} o.pdf
 * @param {string} o.configPath
 * @param {string} [o.babeldocBin]
 * @param {AbortSignal} [o.signal]
 * @param {(evt:{type:string, [k:string]:any})=>void} [o.onEvent]
 * @returns {Promise<{ok:boolean, code:number|null, usage:object, outputs:object, logTail:string, args:string[], signalAborted:boolean}>}
 */
export async function run(o) {
  const bin = o.babeldocBin || path.join(homedir(), '.local', 'bin', 'babeldoc')
  const args = buildArgs(o)
  const langOut = o.langOut || 'zh-CN'
  const watermarkMode = o.watermarkMode || 'no_watermark'
  const outputs = predictOutputs(o.pdf, o.outputDir, langOut, watermarkMode)

  const usage = { total: 0, prompt: 0, completion: 0, cacheHitPrompt: 0, termExtraction: null }
  const tail = []
  let buffered = ''
  let allText = ''
  let aborted = false

  return await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    } catch (error) {
      reject(error)
      return
    }

    const handle = (chunk, stream) => {
      const text = chunk.toString()
      allText += text
      buffered += text
      // BabelDOC 的进度条用 \r 刷新，按 \r 和 \n 都切
      const parts = buffered.split(/\r\n|\r|\n/)
      buffered = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > LOG_TAIL_LINES) tail.shift()
        parseUsage(line, usage)
        const progress = parseProgress(line)
        if (progress && o.onEvent) o.onEvent({ type: 'progress', ...progress })
        if (o.onEvent && /error|Error|failed|Traceback/.test(line)) {
          o.onEvent({ type: 'log', stream, line })
        }
      }
    }

    child.stdout.on('data', (c) => handle(c, 'stdout'))
    child.stderr.on('data', (c) => handle(c, 'stderr'))

    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 5000).unref?.()
    }
    if (o.signal) {
      if (o.signal.aborted) onAbort()
      else o.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (error) => reject(error))
    child.on('close', async (code) => {
      if (o.signal) o.signal.removeEventListener('abort', onAbort)
      if (buffered.trim()) tail.push(buffered)
      // 折行会把「Completion tokens:」和数字拆到两行，所以必须用完整日志再解析一次
      parseUsage(allText, usage)
      if (o.onEvent) o.onEvent({ type: 'done', code, aborted })
      const existing = {
        dual: await fileExists(outputs.dual),
        mono: await fileExists(outputs.mono),
        glossary: await fileExists(outputs.glossary),
      }
      resolve({
        ok: code === 0 && !aborted,
        code,
        usage,
        outputs: { ...outputs, existing },
        logTail: tail.join('\n'),
        args,
        signalAborted: aborted,
      })
    })
  })
}
