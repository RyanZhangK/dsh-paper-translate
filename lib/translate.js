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
import { access, stat } from 'node:fs/promises'
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
    // 有词表就复用；此时 extractGlossary 已被调用方压成 false（见 lib/index.js 的 willExtract），
    // 因为 BabelDOC 一旦抽词就会把用户词表整个丢掉，两者互斥
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
 * BabelDOC 的产物命名有两套，取决于是否分片：
 *   - 分片合并（--max-pages-per-part 触发）：`<stem>[.debug].<lang>.{dual,mono}.pdf`，
 *     没有 .no_watermark 段（result_merger.py 的 mono_file_name/dual_file_name）；
 *   - 单篇直出：mode != watermarked 时带 `.no_watermark` 段（pdf_creater.py write()）；
 *   - 术语表 CSV 更乱：单篇带段、合并后的 glossary 也带段（result_merger.py:136
 *     用的是已追加 .no_watermark 的 debug_suffix）。
 * 只猜一套名字必然在另一种情况下把成功误判成「产物不存在」（0.1.1 的 bug）。
 * 所以两套都列为候选，跑完由 resolveOutputs 按存在性 + mtime 择新。
 * dual/mono/glossary 保留为主候选（带段优先），兼容旧字段语义。
 */
export function predictOutputs(pdf, outputDir, langOut, watermarkMode) {
  const stem = path.basename(pdf, path.extname(pdf))
  const dir = outputDir || path.dirname(pdf)
  const tag = watermarkMode && watermarkMode !== 'watermarked' ? `.${watermarkMode}` : ''
  const tags = tag ? [tag, ''] : ['']
  const mk = (t, suffix) => path.join(dir, `${stem}${t}.${langOut}.${suffix}`)
  return {
    dir,
    dual: mk(tags[0], 'dual.pdf'),
    mono: mk(tags[0], 'mono.pdf'),
    glossary: mk(tags[0], 'glossary.csv'),
    candidates: {
      dual: tags.map((t) => mk(t, 'dual.pdf')),
      mono: tags.map((t) => mk(t, 'mono.pdf')),
      glossary: tags.map((t) => mk(t, 'glossary.csv')),
    },
  }
}

/**
 * 在候选里挑真实存在的产物；两套命名并存时取 mtime 较新者
 * （旧文件可能是上一次运行留下的，不能拿陈年产物冒充本次结果）。
 * 都不存在时回落到主候选名，existing 标 false，由调用方报「产物不存在」。
 */
export async function resolveOutputs(outputs) {
  const pick = async (paths) => {
    let best = null
    let bestMtime = -1
    for (const p of paths) {
      try {
        const st = await stat(p)
        if (st.isFile() && st.mtimeMs > bestMtime) {
          best = p
          bestMtime = st.mtimeMs
        }
      } catch {
        /* 不存在，看下一个候选 */
      }
    }
    return best
  }
  const dual = await pick(outputs.candidates.dual)
  const mono = await pick(outputs.candidates.mono)
  const glossary = await pick(outputs.candidates.glossary)
  return {
    dir: outputs.dir,
    dual: dual || outputs.dual,
    mono: mono || outputs.mono,
    glossary: glossary || outputs.glossary,
    existing: { dual: dual !== null, mono: mono !== null, glossary: glossary !== null },
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
 * 数文本里的 CJK 字符（汉字 + 日文假名）。译文内容验收的判据：
 * 翻成中文/日文的论文每页应有成百上千个 CJK 字符，英文原文副本则接近 0。
 */
export function countCjk(text) {
  let n = 0
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x4dbf)) n++
  }
  return n
}

/**
 * 从 BabelDOC 日志里识别 API 层根因。BabelDOC 对单段翻译失败是「记日志、继续跑」，
 * 全部失败也退出码 0 并原样输出原文——所以根因只能从日志里捞。
 * 返回按 code 去重的 {code, hint} 列表，供工具层渲染修复指引。
 */
export function detectApiErrors(logText) {
  const t = normalizeLog(logText)
  const rules = [
    {
      code: 'QUOTA',
      re: /insufficient_user_quota|额度不足|insufficient quota|quota.*exceeded|余额不足/i,
      hint: 'API 账户额度不足。充值，或传 api: "host" 改用 DSH 宿主模型（LLM 桥），不再依赖这个第三方 key。',
    },
    {
      code: 'AUTH',
      re: /error code: 401|invalid.*api.?key|incorrect api key|authentication.*fail|unauthorized/i,
      hint: 'API key 被拒绝（401）。检查 config.toml 的 openai-api-key 是否过期/写错。',
    },
    {
      code: 'FORBIDDEN',
      re: /error code: 403|\b403\b.*forbidden|access.*denied/i,
      hint: 'API 返回 403。常见于中转站余额为负或模型无权限；确认账户状态与模型名。',
    },
    {
      code: 'RATE_LIMIT',
      re: /error code: 429|rate.?limit|too many requests/i,
      hint: '触发限流（429）。把 poolWorkers 调到 1-2，或稍后重试。',
    },
    {
      code: 'NETWORK',
      re: /APIConnectionError|Connection error|timed? ?out|Name or service not known/i,
      hint: '连不上 API 服务。检查 openai-base-url 与本机网络/代理。',
    },
  ]
  const hits = []
  for (const r of rules) {
    if (r.re.test(t)) hits.push({ code: r.code, hint: r.hint })
  }
  return hits
}

/** 抽样页下标：首尾页 + 均分点，去重。双语交替版里原文页也占一半，抽样要覆盖全篇。 */
export function samplePageIndices(pageCount) {
  const n = Math.max(0, Number(pageCount) || 0)
  if (n === 0) return []
  const idx = new Set([0, n - 1])
  for (let k = 1; k <= 4; k++) idx.add(Math.floor((n * k) / 5))
  return [...idx].filter((i) => i >= 0 && i < n).sort((a, b) => a - b)
}

/**
 * 译文内容验收：用 babeldoc 自带的 python(fitz) 抽几页提取文本数 CJK。
 * 只对 zh/ja 开头的目标语言启用（其他文字系统没有可靠的单字符判据），其余跳过并注明。
 * 阈值 20 字：真译文抽样页应有数百字以上；英文副本里偶见的中文参考文献凑不到 20。
 * python/fitz 不可用时不阻断翻译，返回 checked:false 由调用方提示「未验收」。
 */
export async function verifyTranslation(pdfPath, langOut, pythonBin) {
  if (!/^(zh|ja)/i.test(String(langOut || ''))) {
    return { checked: false, ok: true, reason: `目标语言 ${langOut} 非中日文，跳过内容验收` }
  }
  if (!pythonBin) return { checked: false, ok: true, reason: '无可用 python，跳过内容验收' }
  const script = [
    'import fitz,sys,json',
    'd=fitz.open(sys.argv[1])',
    'n=d.page_count',
    // 与 JS 侧 samplePageIndices 同口径：首尾页 + 五等分点，去重
    'idx=sorted(set([0,n-1]+[n*k//5 for k in range(1,5)]))',
    'idx=[i for i in idx if 0<=i<n]',
    "text=''.join(d[i].get_text() for i in idx)",
    'cjk=sum(1 for ch in text if 0x4e00<=ord(ch)<=0x9fff or 0x3040<=ord(ch)<=0x30ff or 0x3400<=ord(ch)<=0x4dbf)',
    'print(json.dumps({"cjk":cjk,"pages":n,"sampled":len(idx)}))',
  ].join('\n')
  try {
    const { stdout } = await execFileAsync(pythonBin, ['-c', script, pdfPath], { timeout: 60000 })
    const r = JSON.parse(stdout.trim())
    return {
      checked: true,
      ok: r.cjk >= 20,
      cjkCount: r.cjk,
      sampledPages: r.sampled,
      totalPages: r.pages,
    }
  } catch (error) {
    return { checked: false, ok: true, reason: `内容验收执行失败（${error.message}），未验收` }
  }
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
      // 双候选按存在性 + mtime 择新：分片合并产物不带 .no_watermark 段，单篇带
      const resolved = await resolveOutputs(outputs)
      resolve({
        ok: code === 0 && !aborted,
        code,
        usage,
        outputs: resolved,
        // API 层根因（额度/鉴权/限流/网络）：BabelDOC 全失败也退出码 0，只能从日志捞
        apiErrors: detectApiErrors(allText),
        logTail: tail.join('\n'),
        args,
        signalAborted: aborted,
      })
    })
  })
}

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
export function intOption(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}
