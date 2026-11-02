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
import { buildArgs, predictOutputs, parseUsage } from '../lib/translate.js'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

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
  assert.throws(() => safeDomain('../etc'), /./)
  assert.equal(safeDomain(''), 'general', '空值回落到默认领域')
  assert.throws(() => safeDomain('a/b'), /./)
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

test('mergeGlossary 幂等且旧值优先', async () => {
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
  const usage = parseUsage(log, { total: 0, prompt: 0, completion: 0, cacheHitPrompt: 0, termExtraction: null })
  assert.equal(usage.total, 10137)
  assert.equal(usage.prompt, 7756)
  assert.equal(usage.completion, 2381)
  assert.deepEqual(usage.termExtraction, { total: 55832, prompt: 5790, completion: 50042, cacheHitPrompt: 0 })
})

test('predictOutputs 跟随 BabelDOC 命名', () => {
  const o = predictOutputs('/p/Generalized_ICP.pdf', '/out', 'zh-CN', 'no_watermark')
  assert.equal(path.basename(o.dual), 'Generalized_ICP.no_watermark.zh-CN.dual.pdf')
  assert.equal(path.basename(o.mono), 'Generalized_ICP.no_watermark.zh-CN.mono.pdf')
  assert.equal(path.basename(o.glossary), 'Generalized_ICP.no_watermark.zh-CN.glossary.csv')
})

test('成本预估与实测对齐', () => {
  const reuse = estimateTranslation({ pages: 8, model: 'deepseek-v4-flash', hasGlossary: true, extractGlossary: false })
  // 实测：thinking 关闭 + 复用词表，8 页 43,553 tokens
  assert.ok(Math.abs(reuse.tokens.total - 43553) <= 200, `复用词表 8 页预估 ${reuse.tokens.total}`)
  assert.equal(reuse.breakdown.termExtraction, null)

  const first = estimateTranslation({ pages: 8, model: 'deepseek-v4-flash', hasGlossary: false, extractGlossary: true })
  assert.ok(first.tokens.total > reuse.tokens.total, '首次抽取必须比复用贵')
  assert.ok(first.tokens.total < 238099, '仍要明显低于原生基线')

  const noModel = estimateTranslation({ pages: 2, model: 'unknown-model', hasGlossary: true, extractGlossary: false })
  assert.ok(noModel.cost > 0, '未知模型回落到默认单价')
})

test('插件在真实 cordis 容器里注册出 paper_translate', async () => {
  const app = new Context()
  const registered = []
  app.provide('tools', { register: (t) => registered.push(t) })
  app.plugin(plugin)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'paper_translate')
  const props = tool.parameters.properties || {}
  for (const key of ['pdf', 'domain', 'pages', 'extractGlossary', 'dryRun', 'ignoreCache', 'langOut', 'outputDir']) {
    assert.ok(props[key], `缺参数 ${key}`)
  }
  assert.deepEqual(tool.parameters.required, ['pdf'])
  assert.equal(typeof tool.execute, 'function')
})
