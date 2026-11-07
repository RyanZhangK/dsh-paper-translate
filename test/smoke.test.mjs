/**
 * 冒烟测试：不碰网络、不打钱，只验证「命令拼对没拼对、日志算不算得准、
 * 插件装得上装不上」这些一旦错就会静默出问题的地方。
 *
 * 跑：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { parseConfig } from '../lib/detect.js'
import { parseCsv, safeDomain, glossaryPath, mergeGlossary, readGlossary, importBabeldocGlossary } from '../lib/glossary.js'
import { estimateTranslation } from '../lib/estimate.js'
import { buildArgs, predictOutputs, parseUsage, countPages } from '../lib/translate.js'
import { displayWidth, truncate, table, fmtTokens } from '../lib/format.js'
// @deepseek-ai/cordis 与 @deepseek-ai/dsh-tools 由 DSH 宿主提供，npm 上没有可用版本。
// 本地开发用 node_modules 里的符号链接跑真实注册用例；CI 上没有宿主，自动跳过那条。
let Context = null
let plugin = null
try {
  ({ Context } = await import('@deepseek-ai/cordis'))
  plugin = await import('../lib/index.js')
} catch {
  // 宿主包缺失——依赖它们的用例 skip，其余用例照跑
}

// 术语库目录必须重定向到临时目录：早先的用例直接写 ~/.local/share/... 污染了真实数据
process.env.DSH_PAPER_TRANSLATE_GLOSSARY_DIR = path.join(os.tmpdir(), `dpt-glossary-${process.pid}`)

const EMPTY_USAGE = () => ({ total: 0, prompt: 0, completion: 0, cacheHitPrompt: 0, termExtraction: null, parsed: false })

test('parseConfig 跳过注释与段头、去掉引号', () => {
  const cfg = parseConfig(
    [
      '# 注释',
      '[openai]',
      'openai = true',
      'openai-model = "deepseek-v4-flash"',
      "lang-out = 'zh-CN'",
      'output = "/home/x/Documents/translated"',
      'broken-line-without-equals',
    ].join('\n'),
  )
  assert.equal(cfg.openai, 'true')
  assert.equal(cfg['openai-model'], 'deepseek-v4-flash')
  assert.equal(cfg['lang-out'], 'zh-CN')
  assert.equal(cfg.output, '/home/x/Documents/translated')
  assert.equal(Object.keys(cfg).length, 4)
})

test('safeDomain 拦住路径穿越', () => {
  assert.equal(safeDomain('slam'), 'slam')
  assert.equal(safeDomain('rl-v2.1'), 'rl-v2.1')
  assert.equal(safeDomain(''), 'general', '空值回落到默认领域')
  // 断言具体错误码，而不是「抛了任何东西」——后者对类型错误也成立
  assert.throws(() => safeDomain('../etc'), (e) => e.code === 'BAD_DOMAIN')
  assert.throws(() => safeDomain('a/b'), (e) => e.code === 'BAD_DOMAIN')
  assert.throws(() => safeDomain('-lead'), (e) => e.code === 'BAD_DOMAIN')
})

test('parseCsv 解析三列与引号', () => {
  const rows = parseCsv('source,target,tgt_lng\nICP,迭代最近点,zh-CN\n"Generalized-ICP","广义ICP",zh-CN\n')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], ['source', 'target', 'tgt_lng'])
  assert.deepEqual(rows[2], ['Generalized-ICP', '广义ICP', 'zh-CN'])
})

test('importBabeldocGlossary 跳过脏行', async () => {
  const tmp = path.join(os.tmpdir(), `gloss-${process.pid}-${Date.now()}.csv`)
  await writeFile(
    tmp,
    '\ufeffsource,target,tgt_lng\nICP,迭代最近点,zh-CN\n  ,空源,zh-CN\npoint-to-plane,,zh-CN\nGeneralized-ICP,广义ICP,zh-CN\n',
    'utf8',
  )
  try {
    const rows = await importBabeldocGlossary(tmp)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].source, 'ICP')
    assert.equal(rows[1].source, 'Generalized-ICP')
  } finally {
    await rm(tmp, { force: true })
  }
})

test('mergeGlossary 幂等、旧值优先、且按目标语言区分', async () => {
  const domain = 'smoke-test'
  const file = glossaryPath(domain)
  await rm(file, { force: true })
  try {
    const first = await mergeGlossary(domain, [
      { source: 'ICP', target: '迭代最近点' },
      { source: 'icp', target: '不该覆盖' },
    ])
    assert.equal(first.total, 1, '大小写不敏感去重')
    const again = await mergeGlossary(domain, [{ source: 'ICP', target: '换个译法' }])
    assert.equal(again.added, 0)
    assert.equal(again.total, 1)

    // 同一个词翻成别的语言是一条独立记录，不能因为 source 相同就被吞掉
    const en = await mergeGlossary(domain, [{ source: 'ICP', target: 'Iterative Closest Point', tgtLng: 'en' }])
    assert.equal(en.added, 1, '不同目标语言不算重复')
    assert.equal(en.total, 2)

    const rows = await readGlossary(domain)
    assert.equal(rows[0].target, '迭代最近点', '旧值优先')
    const text = await readFile(file, 'utf8')
    assert.ok(text.startsWith('source,target'), '带表头，能直接喂回 BabelDOC')
  } finally {
    await rm(file, { force: true })
  }
})

test('buildArgs 恒注入 -c 与 --openai-thinking disabled', () => {
  const base = buildArgs({ pdf: '/p/a.pdf', configPath: '/p/c.toml', thinking: 'disabled' })
  assert.deepEqual(base.slice(0, 4), ['--config', '/p/c.toml', '--files', '/p/a.pdf'])
  assert.ok(base.includes('--openai-thinking') && base.includes('disabled'))
  assert.ok(base.includes('--save-auto-extracted-glossary'), '不传就不落盘术语表')

  const noExtract = buildArgs({ pdf: '/p/a.pdf', configPath: '/p/c.toml', extractGlossary: false })
  assert.ok(noExtract.includes('--no-auto-extract-glossary'))
  assert.ok(!noExtract.includes('--save-auto-extracted-glossary'))

  const withGloss = buildArgs({
    pdf: '/p/a.pdf',
    configPath: '/p/c.toml',
    extractGlossary: true,
    glossaryFile: '/g/slam.csv',
    ignoreCache: true,
  })
  assert.ok(withGloss.includes('--glossary-files') && withGloss.includes('/g/slam.csv'))
  assert.ok(withGloss.includes('--ignore-cache'))
})

test('parseUsage 认得 rich logging 的折行数字', () => {
  const log = [
    'INFO     INFO:babeldoc.main:Total tokens: 10137  main.py:772',
    '                    INFO     INFO:babeldoc.main:Prompt tokens: 7756  main.py:773',
    '                    INFO     INFO:babeldoc.main:Completion tokens:   main.py:774',
    '                             2381                                               ',
    '                    INFO     INFO:babeldoc.main:Cache hit prompt     main.py:775',
    '                             tokens: 0                                         ',
    '                    INFO     INFO:babeldoc.main:Term extraction      main.py:778',
    '                             tokens: total=55832 prompt=5790 completion=50042',
    '                             cache_hit_prompt=0',
  ].join('\n')
  const usage = parseUsage(log, EMPTY_USAGE())
  assert.equal(usage.total, 10137)
  assert.equal(usage.prompt, 7756)
  assert.equal(usage.completion, 2381)
  assert.equal(usage.parsed, true)
  assert.deepEqual(usage.termExtraction, { total: 55832, prompt: 5790, completion: 50042, cacheHitPrompt: 0 })
})

test('parseUsage 区分「缓存命中 0 token」与「压根没解析到」', () => {
  // 解析不到任何字段：不能当成缓存命中，否则钱花了却报 0
  assert.equal(parseUsage('INFO 什么都没有', EMPTY_USAGE()).parsed, false)
  // 真的解析出 0：这才是缓存命中
  const zero = parseUsage('INFO Total tokens: 0 Prompt tokens: 0 Completion tokens: 0', EMPTY_USAGE())
  assert.equal(zero.parsed, true)
  assert.equal(zero.total, 0)
})

test('predictOutputs 跟随 BabelDOC 命名', () => {
  const o = predictOutputs('/p/Generalized_ICP.pdf', '/out', 'zh-CN', 'no_watermark')
  assert.equal(path.basename(o.dual), 'Generalized_ICP.no_watermark.zh-CN.dual.pdf')
  assert.equal(path.basename(o.mono), 'Generalized_ICP.no_watermark.zh-CN.mono.pdf')
  assert.equal(path.basename(o.glossary), 'Generalized_ICP.no_watermark.zh-CN.glossary.csv')

  // watermarked 模式不追加那一段，拼错了会把成功报成「产物不存在」
  const w = predictOutputs('/p/a.pdf', '/out', 'zh-CN', 'watermarked')
  assert.equal(path.basename(w.dual), 'a.zh-CN.dual.pdf')
})

test('countPages 与 babeldoc 的 --pages 语义一致', () => {
  assert.equal(countPages('1-3', 10), 3)
  assert.equal(countPages('-3', 10), 3, '开放区间：前 3 页')
  assert.equal(countPages('5-', 10), 6, '开放区间：第 5 页到末尾')
  assert.equal(countPages('5-100', 10), 6, '右界越界裁到总页数')
  assert.equal(countPages('1-3,2-4', 10), 4, '重叠区间要去重')
  assert.equal(countPages('0', 10), 10, '非法页回退整篇')
  assert.equal(countPages('', 10), 10)
  assert.equal(countPages('1,3,5', 10), 3)
})

test('成本预估与实测对齐', () => {
  const reuse = estimateTranslation({ pages: 8, model: 'deepseek-v4-flash', hasGlossary: true, extractGlossary: false })
  // 实测：thinking 关闭 + 复用词表，8 页 43,553 tokens
  assert.ok(Math.abs(reuse.tokens.total - 43553) <= 200, `复用词表 8 页预估 ${reuse.tokens.total}`)
  assert.equal(reuse.breakdown.termExtraction, null)

  const first = estimateTranslation({ pages: 8, model: 'deepseek-v4-flash', hasGlossary: false, extractGlossary: true })
  assert.ok(first.tokens.total > reuse.tokens.total, '首次抽取必须比复用贵')
  assert.ok(first.tokens.total < 238099, '仍要明显低于原生基线')

  // pricing 真接线了才谈得上「未知模型回落默认单价」
  const custom = estimateTranslation({
    pages: 8,
    model: 'mystery',
    hasGlossary: true,
    extractGlossary: false,
    pricing: { mystery: { input: 9, output: 9 } },
  })
  assert.ok(custom.cost > 0)
})

test('插件在真实 cordis 容器里注册出 paper_translate', async (t) => {
  if (!Context || !plugin) return t.skip('未找到 @deepseek-ai/cordis / @deepseek-ai/dsh-tools：无 DSH 宿主环境（CI 上的正常现象）')
  const app = new Context()
  const registered = []
  app.provide('tools', { register: (t) => registered.push(t) })
  app.plugin(plugin)
  // 不要用固定的 setTimeout 猜时序，轮询到注册完成为止
  for (let i = 0; i < 100 && registered.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  try {
    assert.equal(registered.length, 1)
    const tool = registered[0]
    assert.equal(tool.name, 'paper_translate')
    const props = tool.parameters.properties || {}
    for (const key of ['pdf', 'domain', 'pages', 'extractGlossary', 'dryRun', 'ignoreCache', 'langOut', 'outputDir']) {
      assert.ok(props[key], `缺参数 ${key}`)
    }
    assert.deepEqual(tool.parameters.required, ['pdf'])
    assert.equal(typeof tool.execute, 'function')
  } finally {
    await app.dispose?.()
  }
})

test('displayWidth 按东亚宽度算列，不吃 emoji 与 ANSI', () => {
  assert.equal(displayWidth('abc'), 3)
  assert.equal(displayWidth('中文'), 4)
  assert.equal(displayWidth('译'), 2)
  // 中英混排是最容易按 length 补错的地方
  assert.equal(displayWidth('a中b'), 4)
  assert.equal(displayWidth('🐋'), 2)
  // ANSI 转义宽 0：按字节补空格是整行错位的经典原因
  assert.equal(displayWidth('\u001b[31mred\u001b[0m'), 3)
})

test('truncate 超宽补省略号且不越界', () => {
  assert.equal(truncate('abcdef', 10), 'abcdef')
  const cut = truncate('中文中文中文中文', 10)
  assert.ok(displayWidth(cut) <= 10, `截断后超宽：${cut}`)
  assert.ok(cut.endsWith('…'))
  // width 为 0 时不能返回省略号，那会把列撑破
  assert.equal(truncate('abc', 0), '')
})

test('table 每行不超总宽，数值列按显示宽度对齐', () => {
  const lines = table([
    ['页数', '8 页'],
    ['目标语言', 'zh-CN'],
  ], { width: 40 })
  for (const line of lines) assert.ok(displayWidth(line) <= 40, `超宽：${line}`)
  // 两行的数值都从第 10 显示列开始（标签列 8 + 间隔 2）；字符索引不同，这才是不能用 length 的理由
  const colOf = (line, needle) => displayWidth(line.slice(0, line.indexOf(needle)))
  assert.equal(colOf(lines[0], '8 页'), 10)
  assert.equal(colOf(lines[1], 'zh-CN'), 10)

  // 标签本身比总宽还长时也要截断标签，否则整行必然溢出
  const long = table([['@deepseek-ai/dsh-experimental-inspector-profile', 'MISSING']], { width: 30 })
  assert.ok(displayWidth(long[0]) <= 30, `标签超长时溢出：${long[0]}`)
})

test('fmtTokens 千分位与 locale 无关', () => {
  assert.equal(fmtTokens(43542), '43,542')
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(238099), '238,099')
  // usage 解析出来的是字符串，不能只接受 number
  assert.equal(fmtTokens('1234567'), '1,234,567')
})
