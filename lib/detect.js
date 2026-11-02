/**
 * lib/detect.js —— 运行环境探测
 *
 * 插件不替用户装 BabelDOC，只负责把「哪里不对、怎么修」说清楚。
 * 所有检查都汇聚成结构化 problem（code / message / fix），不抛异常，
 * 由工具层统一渲染成人读文本。
 */
import { access, readFile } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export const DEFAULT_CONFIG_PATH = path.join(homedir(), '.config', 'babeldoc', 'config.toml')
export const DEFAULT_OUTPUT_DIR = path.join(homedir(), 'Documents', 'translated')
export const DEFAULT_UV_PYTHON = path.join(homedir(), '.local', 'share', 'uv', 'tools', 'babeldoc', 'bin', 'python')
export const DEFAULT_BABELDOC_BIN = path.join(homedir(), '.local', 'bin', 'babeldoc')

/** config.toml 只需要 key = value 这一层，段头和注释直接跳过。 */
export function parseConfig(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (val.length >= 2) {
      const q = val[0]
      if ((q === '"' || q === "'") && val.endsWith(q)) val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

function majorOf(version) {
  const m = /^(\d+)/.exec(String(version || '').trim())
  return m ? Number(m[1]) : null
}

async function exists(file) {
  try {
    await access(file, FS.X_OK)
    return true
  } catch {
    return false
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 解析出 babeldoc 所在的 Python 解释器。
 * 顺序：显式指定 → uv tool 默认路径 → babeldoc 可执行文件的 shebang → PATH 里的 python3。
 * 之所以要它，是因为 bitstring 的坑只在 babeldoc 自己的 venv 里才看得见。
 */
export async function resolvePython({ pythonBin, babeldocBin } = {}) {
  if (pythonBin) return pythonBin
  if (await exists(DEFAULT_UV_PYTHON)) return DEFAULT_UV_PYTHON
  const bin = babeldocBin || DEFAULT_BABELDOC_BIN
  try {
    const fd = await readFile(bin, 'utf8')
    const first = fd.split(/\r?\n/, 1)[0]
    if (first.startsWith('#!')) {
      const candidate = first.slice(2).trim().split(/\s+/)[0]
      if (candidate && path.isAbsolute(candidate) && (await exists(candidate))) return candidate
    }
  } catch {
    /* 不是文本脚本，继续兜底 */
  }
  return 'python3'
}

async function readBitstringVersion(pythonBin) {
  try {
    const { stdout } = await execFileAsync(
      pythonBin,
      ['-c', 'import bitstring; print(bitstring.__version__)'],
      { timeout: 15000 },
    )
    return stdout.trim()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function probeApi(config) {
  try {
    const url = config.baseUrl.replace(/\/+$/, '') + '/models'
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15000),
    })
    if (res.status === 401) return { ok: false, message: 'API key 被拒绝（401）' }
    if (!res.ok) return { ok: false, message: `API 返回 HTTP ${res.status}` }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 全量环境检查。
 * @param {object} [opts]
 * @param {string} [opts.configPath] 覆盖默认 config.toml 路径
 * @param {string} [opts.babeldocBin] 覆盖 babeldoc 可执行路径
 * @param {string} [opts.pythonBin] 覆盖 Python 解释器
 * @param {boolean} [opts.probe] 是否额外探活 /models（默认 false，避免每次翻译多打一次网络）
 * @returns {Promise<{ok:boolean, problems:Array<{code:string,message:string,fix?:string}>, warnings:Array<object>, config:object, babeldocBin:string, pythonBin:string}>}
 */
export async function checkEnvironment(opts = {}) {
  const configPath = opts.configPath || process.env.BABELDOC_CONFIG || DEFAULT_CONFIG_PATH
  const babeldocBin = opts.babeldocBin || process.env.BABELDOC_BIN || DEFAULT_BABELDOC_BIN
  const problems = []
  const warnings = []
  const config = {}
  const result = { ok: false, problems, warnings, config, babeldocBin, pythonBin: '' }

  // 1) babeldoc 本体
  const binOk = await exists(babeldocBin)
  if (!binOk) {
    problems.push({
      code: 'NO_BABELDOC',
      message: `找不到 BabelDOC 可执行文件：${babeldocBin}`,
      fix: 'uv tool install --python 3.12 BabelDOC',
    })
  }

  // 2) config
  const text = await readText(configPath)
  if (text === null) {
    problems.push({
      code: 'CONFIG_UNREADABLE',
      message: `读不到 BabelDOC 配置文件：${configPath}`,
      fix: `mkdir -p ${path.dirname(configPath)} && 按 README 写入 openai / openai-api-key / openai-base-url / openai-model`,
    })
  } else {
    Object.assign(config, parseConfig(text))
    if (String(config.openai).toLowerCase() !== 'true') {
      problems.push({
        code: 'MISSING_OPENAI',
        message: '配置里没有启用 OpenAI 兼容服务（openai = "true"）',
        fix: `在 ${configPath} 写入 openai = "true"`,
      })
    }
    for (const key of ['openai-model', 'openai-base-url', 'openai-api-key']) {
      if (!config[key]) {
        problems.push({
          code: 'MISSING_KEY',
          message: `配置缺少 ${key}`,
          fix: `在 ${configPath} 补上 ${key} = "..."`,
        })
      }
    }
  }

  // 3) bitstring 版本：5.x 删了 BitStream，babeldoc 直接 ImportError
  const pythonBin = await resolvePython({ pythonBin: opts.pythonBin, babeldocBin })
  result.pythonBin = pythonBin
  const bit = await readBitstringVersion(pythonBin)
  if (typeof bit === 'object' && bit.error) {
    warnings.push({
      code: 'BITSTRING_UNKNOWN',
      message: `无法用 ${pythonBin} 查询 bitstring 版本：${bit.error}`,
    })
  } else {
    const major = majorOf(bit)
    if (major !== null && major >= 5) {
      problems.push({
        code: 'BITSTRING_TOO_NEW',
        message: `babeldoc 环境里的 bitstring 为 ${bit}，5.x 移除了 BitStream，会让 BabelDOC 启动即 ImportError`,
        fix: `uv pip install --python ${pythonBin} "bitstring>=4.3,<5"`,
      })
    }
    config.bitstring = bit
  }

  // 4) 归一化输出配置
  result.config = {
    ...config,
    configPath,
    baseUrl: config['openai-base-url'] || '',
    model: config['openai-model'] || '',
    apiKey: config['openai-api-key'] || '',
    outputDir: config.output || DEFAULT_OUTPUT_DIR,
    langOut: config['lang-out'] || 'zh-CN',
  }

  // 5) 可选探活
  if (opts.probe && result.config.baseUrl && result.config.apiKey) {
    const api = await probeApi(result.config)
    if (!api.ok) {
      problems.push({
        code: 'API_UNREACHABLE',
        message: `API 探活失败：${api.message}`,
        fix: `确认 ${result.config.baseUrl} 可从本机访问，且模型 ${result.config.model} 在该服务上可用`,
      })
    }
  }

  result.ok = problems.length === 0
  return result
}

/** 把 problems 渲染成多行文本，给工具层和 README 示例共用。 */
export function formatProblems(problems) {
  if (!problems.length) return ''
  return problems
    .map((p, i) => `${i + 1}. [${p.code}] ${p.message}${p.fix ? `\n   修复：${p.fix}` : ''}`)
    .join('\n')
}
