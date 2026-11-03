# dsh-paper-translate

把 [BabelDOC](https://github.com/funstory-ai/BabelDOC) 包成一个 DSH 工具：整篇 PDF 文献 → 中文双语对照版，**先报成本，再动手**。

它不重新发明翻译，只补掉直接用 BabelDOC 时会踩到的三个坑。

## 三个坑

**1. BabelDOC 不读自己的 config**

`~/.config/babeldoc/config.toml` 写得好好的，直接跑 `babeldoc paper.pdf` 却报：

```
error: 必须选择一个翻译服务：--openai
```

因为 `babeldoc/main.py` 里的 `configargparse.ArgParser` 既没传 `default_config_files`，`-c/--config` 也没有默认值——**它压根不会自动去找那个文件**。本插件永远显式传 `-c`。

**2. 服务端默认偷偷开 thinking**

同一段 1052 字符的正文，同一个 prompt，只改 `extra_body`：

| 请求 | completion | reasoning_tokens | 总 token | 耗时 |
| --- | --- | --- | --- | --- |
| 不传 thinking（默认） | 754 | 585 | 1092 | 9.6s |
| `thinking: disabled` | 174 | 0 | 433 | 3.3s |
| `thinking: enabled` | 1618 | 1449 | 1956 | 15.3s |

默认状态下 **77.6% 的 completion 是推理 token**，而译文长度几乎没变（299 vs 298 字符）。本插件固定传 `--openai-thinking disabled`。

**3. 术语表本来可以复用，却每篇重抽一遍**

8 页论文实测：总 238,099 token，其中术语提取占 55,832。BabelDOC 每次翻译都重新抽一遍。本插件按 `domain` 把术语存成 `~/.local/share/dsh-paper-translate/glossary/<domain>.csv`，第二篇同领域论文直接复用，还能回填新增的词。

## 成本

以那篇 8 页论文为基线：

| 场景 | 总 token | 占基线 |
| --- | --- | --- |
| 原生 BabelDOC | 238,099 | 100% |
| 本插件，首次（要抽术语） | ~99,385 | 41.7% |
| 本插件，复用词表（实测 43,553） | 43,553 | 18.3% |

按 deepseek-v4-flash 价格，复用词表约 ¥0.035 一次，首次约 ¥0.14。实际值受文字量和公式密度影响。

## 装

不发 npm，两种装法，都走 `dsh plugin`（它会同时写 `dependencies` 和 `dsh.profile.bundles`）：

**A. 直接从 GitHub 装**（推荐，一条命令）：

```bash
dsh plugin --profile <你的 profile> add github:RyanZhangK/dsh-paper-translate
```

**B. 本地 clone + link**（要改代码时用）：

```bash
git clone https://github.com/RyanZhangK/dsh-paper-translate.git
dsh plugin --profile <你的 profile> add link:/绝对路径/dsh-paper-translate
```

> 不需要自己 `npm install`。`@deepseek-ai/cordis` 和 `@deepseek-ai/dsh-tools` 是 **optional peer**，运行时由 DSH 宿主解析（`dsh-app-boot` 的 `HostResolvedRootInclude.import()` 把 bare specifier 指到宿主安装目录），所以插件目录里没有 `node_modules` 也能跑。
>
> 这两个 peer 必须写真实版本范围并标 `"optional": true`。写成 `"*"` 时 pnpm 会去 registry 找满足 `*` 的 `@deepseek-ai/dsh-tools`（只有 0.0.1-rc.1），而它依赖的 `@deepseek-ai/dsh-type-meta` 从没发布过，安装会以 `ERR_PNPM_FETCH_404` 失败。

> ⚠️ 关键点：只往 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加一行、再 `npm install`，**插件不会生效**。DSH 启动时只加载 `dsh.profile.bundles` 里列出的包（`dsh-app-boot` 的 `loadProfileDirectory()`），那个数组是 `dsh plugin add` 才会帮你补的。
>
> 确实要手工装的话，两个地方都得改：`dependencies` 加 `"dsh-paper-translate": "link:/绝对路径/dsh-paper-translate"`，**并且**把它追加进 `dsh.profile.bundles` 数组。

装完重启 DSH，插件会在 `tools` 服务就绪后自己挂上，不需要额外配置。

要自定义并发等参数，在 cordis 配置里给 `paper-translate` 这一行加 `config`（见 `cordis.patch.yml` 的注释）。

## 用

工具名 `paper_translate`。

| 参数 | 说明 |
| --- | --- |
| `pdf` | 必填，PDF **绝对路径**（工具进程的 cwd 不是你的 shell 目录，相对路径会解析到别处，插件直接拒绝） |
| `domain` | 术语库领域，如 `slam` / `rl` / `cv`，默认 `general`。同领域论文共用一份术语表 |
| `pages` | 只翻部分页，如 `1-6` 或 `1,3,7-9` |
| `extractGlossary` | 是否允许现场抽取术语。默认 `true`，但**只有该领域还没有可用词表时才会真的抽**——BabelDOC 一旦抽词就会把 `--glossary-files` 的用户词表整个丢弃（`get_glossaries_for_translation()` 直接 return 自动词表），两者互斥。传 `false` 表示只复用词表、不花钱抽新词 |
| `langOut` | 目标语言，默认沿用 config 的 `lang-out` |
| `outputDir` | 输出目录，默认沿用 config 的 `output` |
| `dryRun` | 只做环境检查 + 成本预估，不启动翻译 |
| `ignoreCache` | 忽略 BabelDOC 的翻译缓存强制重翻。默认复用缓存——同一份 PDF 再跑一次是 0 token |

典型用法：

> 用 paper_translate 先 dryRun 估一下这篇 PDF 要花多少 token
>
> 把这篇论文翻成中文，domain 用 slam

输出是 `<论文名>.no_watermark.zh-CN.dual.pdf`（原文/译文交替，适合对照读）和 `.mono.pdf`（纯译文）。看完实际用量会告诉你和预估差多少。

## 依赖

不代装。缺什么就把准确的修复命令交回来，让你（或模型）决定要不要执行。会检查：

- `babeldoc` 在不在 PATH
- config 能不能读、有没有 `openai = true` 和 `openai-api-key`
- **bitstring 版本**：BabelDOC 0.6.4 依赖的 `bitstring` 5.0 移除了 `BitStream`，会直接 `ImportError`。需要 `bitstring>=4.3,<5`：

  ```bash
  uv pip install --python ~/.local/share/uv/tools/babeldoc/bin/python "bitstring>=4.3,<5"
  ```
- API 是否可达（只在显式要求探活时测）

少见的解析失败（`AssertionError: assert total_pages > 0`）是 BabelDOC 对个别 PDF 的兼容问题，不是本插件能修的，换 `--enhance-compatibility` 或换文件。

## 已知限制

- 只处理有文本层的 PDF；扫描件不会自动 OCR。
- 不处理非 PDF。
- 术语表按 `source` + `tgt_lng` 去重（`source` 大小写不敏感），**旧值优先**，新词只增不覆盖。同一个词翻成另一种语言算独立记录。
- 并发默认 2：低余额账户的 API 并发上限只有 3，开 4 会稳定撞 429。
- BabelDOC 默认复用翻译缓存，同一份 PDF 第二次跑是 0 token（结果里会说明）。想重翻就传 `ignoreCache`。
- 成本预估按「页均摊」推，整篇翻译时比较准；只翻前一两页试读时，实测会明显低于预估（首页文字量通常少于平均页）。

## License

MIT
