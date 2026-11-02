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

/**
 * BabelDOC 的产物命名规则：`<stem>[.<watermark>].<langOut>.{dual,mono}.pdf`
 * 只有 watermark 模式不是 watermarked 时才追加那一段（pdf_creater 里就是这么判断的），
 * 一律拼 `.no_watermark` 会在 watermarked 模式下把成功误判成「产物不存在」。
 */
export function predictOutputs(pdf, outputDir, langOut, watermarkMode) {
  const stem = path.basename(pdf, path.extname(pdf))
  const dir = outputDir || path.dirname(pdf)
  const tag = watermarkMode && watermarkMode !== 'watermarked' ? `.${watermarkMode}` : ''
  return {
    dir,
    dual: path.join(dir, `${stem}${tag}.${langOut}.dual.pdf`),
    mono: path.join(dir, `${stem}${tag}.${langOut}.mono.pdf`),
    glossary: path.join(dir, `${stem}${tag}.${langOut}.glossary.csv`),
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
    let hit = false
    const rx = new RegExp(re, 'g')
    while ((m = rx.exec(t)) !== null) {
      usage[key] = Number(m[1])
      hit = true
    }
    return hit
  }
  // parsed 用来区分「真的 0 token（命中缓存）」和「日志格式变了、一个字段都没解析到」。
  // 少了它，解析失败会被说成缓存命中，钱已经花了却报 0。
  if (take('Total tokens:\\s*(\\d+)', 'total')) usage.parsed = true
  take('Prompt tokens:\\s*(\\d+)', 'prompt')
  take('Completion tokens:\\s*(\\d+)', 'completion')
  take('Cache hit prompt tokens:\\s*(\\d+)', 'cacheHitPrompt')

  const term = /Term extraction tokens:\s*total=(\d+)\s*prompt=(\d+)\s*completion=(\d+)(?:\s*cache_hit_prompt=(\d+))?/.exec(t)
  if (term) {
    usage.parsed = true
    usage.termExtraction = {
      total: Number(term[1]),
      prompt: Number(term[2]),
      completion: Number(term[3]),
      cacheHitPrompt: term[4] ? Number(term[4]) : 0,
    }
  }
  return usage
}

/**
 * 跑一次翻译。
 * @param {object} o
 * @param {string} o.pdf
 * @param {string} o.configPath
 * @param {string} [o.babeldocBin]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{ok:boolean, code:number|null, usage:object, outputs:object, logTail:string, args:string[], signalAborted:boolean}>}
 */
/** 完整日志只留末尾一段：解析用量靠的是结尾的汇总行，没必要把几十 MB 全攒在内存里。 */
const MAX_TEXT_BYTES = 1 << 20

export async function run(o) {
  const bin = o.babeldocBin || path.join(homedir(), '.local', 'bin', 'babeldoc')
  const args = buildArgs(o)
  const langOut = o.langOut || 'zh-CN'
  const watermarkMode = o.watermarkMode || 'no_watermark'
  const outputs = predictOutputs(o.pdf, o.outputDir, langOut, watermarkMode)

  const usage = { total: 0, prompt: 0, completion: 0, cacheHitPrompt: 0, termExtraction: null, parsed: false }
  const tail = []
  let buffered = ''
  let allText = ''
  let aborted = false

  return await new Promise((resolve, reject) => {
    let child
    try {
      // detached 让子进程自成进程组，取消时能连同 babeldoc 的工作线程一起杀掉；
      // 只 SIGTERM 直接子进程的话，在途 HTTP 请求还会继续烧 token
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, detached: true })
    } catch (error) {
      reject(error)
      return
    }

    const handle = (chunk) => {
      const text = chunk.toString()
      allText += text
      if (allText.length > MAX_TEXT_BYTES) allText = allText.slice(-MAX_TEXT_BYTES)
      buffered += text
      // BabelDOC 的进度条用 \r 刷新，按 \r 和 \n 都切
      const parts = buffered.split(/\r\n|\r|\n/)
      buffered = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > LOG_TAIL_LINES) tail.shift()
        parseUsage(line, usage)
      }
    }

    child.stdout.on('data', handle)
    child.stderr.on('data', handle)

    let killTimer = null
    const signalTree = (sig) => {
      try {
        process.kill(-child.pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          /* 已经退了 */
        }
      }
    }
    const onAbort = () => {
      aborted = true
      signalTree('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode === null) signalTree('SIGKILL')
      }, 5000)
      killTimer.unref?.()
    }
    if (o.signal) {
      if (o.signal.aborted) onAbort()
      else o.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (error) => {
      if (killTimer) clearTimeout(killTimer)
      reject(error)
    })
    child.on('close', async (code) => {
      if (killTimer) clearTimeout(killTimer)
      if (o.signal) o.signal.removeEventListener('abort', onAbort)
      if (buffered.trim()) tail.push(buffered)
      // 折行会把「Completion tokens:」和数字拆到两行，所以必须用完整日志再解析一次
      parseUsage(allText, usage)
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
