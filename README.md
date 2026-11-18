# dsh-paper-translate

[![CI](https://github.com/RyanZhangK/dsh-paper-translate/actions/workflows/ci.yml/badge.svg)](https://github.com/RyanZhangK/dsh-paper-translate/actions/workflows/ci.yml)

> 把 [BabelDOC](https://github.com/funstory-ai/BabelDOC) 包成一个 DSH 工具：整篇 PDF 文献 → 中文双语对照版，**先报成本，再动手**。

它不重新发明翻译，只补掉直接用 BabelDOC 时会踩到的坑：不读自己的 config、服务端偷偷开 thinking、术语表每篇重抽一遍、产物名猜错把成功报成失败、API 全挂了还拿原文副本冒充译文。

## ✨ 特性

- **复用 DSH 宿主模型（LLM 桥）**：`api: "host"` 直接在本地起一个 OpenAI 兼容桥，把 BabelDOC 接到「当前会话正在用的模型」上，**不用第三方 key、不用写 config.toml**。默认 `auto`：宿主有模型就走桥，没有才回落第三方 config
- **先报成本再动手**：`dryRun: true` 直接给出这篇 PDF 要花多少 token、折合多少钱，不满意就不跑
- **译文内容验收**：跑完抽样数 CJK 字符，API 全失败时 BabelDOC 会原样输出原文且退出码 0——本插件识破这种「假成功」，报失败并从日志里捞出根因（额度不足 / key 失效 / 限流 / 断网）
- **关掉隐藏的推理开销**：固定传 `--openai-thinking disabled`（host 模式则在桥里选最低 reasoning 档），实测 completion 降 77%，译文长度几乎不变
- **术语表跨文档复用**：按 `domain` 存 `~/.local/share/dsh-paper-translate/glossary/<domain>.csv`，同领域第二篇论文直接复用，跑完还会把新增术语回填进去
- **环境自检**：缺 BabelDOC、config 缺 key、`bitstring` 版本不对，都把准确的修复命令交回来，而不是抛一堆 traceback
- **双语对照输出**：`.dual.pdf`（原文/译文交替）+ `.mono.pdf`（纯译文），带不带 `.no_watermark` 段两种命名都认得
- **缓存透明**：命中 BabelDOC 本地翻译缓存时明确告诉你 0 token，想强制重翻传 `ignoreCache: true`

## 📸 预览

![双语对照产物：原文与译文逐页交替](assets/screenshot-1.png)

![dryRun 成本预估输出](assets/screenshot-2.png)

## 📦 安装

不发 npm，两种装法，都走 `dsh plugin`（它会同时写 `dependencies` 和 `dsh.profile.bundles`）：

```bash
# A. 直接从 GitHub 装（推荐，一条命令）
dsh plugin --profile web add github:RyanZhangK/dsh-paper-translate

# B. 本地 clone + link（要改代码时用）
git clone https://github.com/RyanZhangK/dsh-paper-translate.git
dsh plugin --profile web add link:/绝对路径/dsh-paper-translate
```

安装后重启 `dsh web` 即可使用。**用 DSH 宿主模型（默认 `auto`/`host`）不需要任何额外配置**；只有走第三方 API（`api: "config"`）才需要写 `~/.config/babeldoc/config.toml`（模板见下文「翻译 API 来源」）。

> 不用自己 `npm install`。`@deepseek-ai/cordis` 和 `@deepseek-ai/dsh-tools` 是 **optional peer**，运行时由 DSH 宿主解析（`dsh-app-boot` 的 `HostResolvedRootInclude.import()` 把 bare specifier 指到宿主安装目录），所以插件目录里没有 `node_modules` 也能跑。
>
> 这两个 peer 必须写真实版本范围并标 `"optional": true`。写成 `"*"` 时 pnpm 会去 registry 找满足 `*` 的 `@deepseek-ai/dsh-tools`（只有 `0.0.1-rc.1`），而它依赖的 `@deepseek-ai/dsh-type-meta` 从没发布过，安装会以 `ERR_PNPM_FETCH_404` 失败。

> ⚠️ 只往 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加一行、再 `npm install`，**插件不会生效**。DSH 启动时只加载 `dsh.profile.bundles` 里列出的包（`dsh-app-boot` 的 `loadProfileDirectory()`），那个数组是 `dsh plugin add` 才会帮你补的。
>
> 确实要手工装，两个地方都得改：`dependencies` 加 `"dsh-paper-translate": "github:RyanZhangK/dsh-paper-translate"`，**并且**把它追加进 `dsh.profile.bundles` 数组。

要调并发等参数，在 profile 的 `cordis.patch.yml` 里给 `paper-translate` 这一行加 `config`（见本仓库 [`cordis.patch.yml`](./cordis.patch.yml) 的注释）。

## 🎯 使用

工具名 `paper_translate`，参数：

| 参数 | 说明 |
| --- | --- |
| `pdf` | 必填，PDF **绝对路径**（工具进程的 cwd 不是你的 shell 目录，相对路径会解析到别处，插件直接拒绝） |
| `api` | 翻译 API 来源：`host`（DSH 宿主模型，走 LLM 桥，无需第三方 key）/ `config`（BabelDOC config.toml 的第三方 API）/ `auto`（默认，宿主有模型走 host，否则回落 config 并明示） |
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

输出是 `<论文名>.zh-CN.dual.pdf`（原文/译文交替，适合对照读）和 `.mono.pdf`（纯译文）。BabelDOC 分片合并的产物不带 `.no_watermark` 段、单篇产物带，两种命名本插件都认得（按存在性 + 修改时间挑本次的那份）。跑完会告诉你实际用量和预估差多少，并报告内容验收结果。

## 🌉 翻译 API 来源（LLM 桥）

BabelDOC 是个独立 Python 进程，自己拿 openai SDK 发 HTTP，读不到 DSH 宿主的账号凭据（那是登录态 + 模型准入，不是静态 key）。`api: "host"` 的做法是：插件在本地起一个**只绑 127.0.0.1、随机端口、随机 bearer token** 的 OpenAI 兼容小服务（`lib/llm-bridge.js`），把 BabelDOC 的请求转成宿主 `ctx.llm` 调用，再把流式结果聚合回非流式响应。翻译用的就是「当前会话正在用的模型」，计费走宿主，不再依赖任何第三方 key。

- **`host`**：强制走桥。宿主没挂 llm 服务时直接报错并给指引，不会静默回落。
- **`config`**：强制走 `config.toml` 的第三方 API（0.1.x 的老行为，完全不变）。
- **`auto`**（默认）：宿主 llm 可用走 host，否则回落 config，并在输出里明示走了哪条。

桥的生命周期与单次翻译绑定：跑完（无论成功/失败/中止）即关桥、删临时 config；fiber 中途卸载也有 `ctx.effect` 兜底关桥。临时 config 只含桥的 API 字段和你 config 里的**非 API 偏好**（如 `max-pages-per-part`），**绝不抄你的第三方 key**。

想指定桥用哪个宿主模型（而不是默认模型），在 profile 的 `cordis.patch.yml` 给 `paper-translate` 加：

```yaml
config:
  llmBridge:
    provider: deepseek      # 宿主 provider id
    model: deepseek-v4-flash
    reasoningEffort: low    # 可选；不填自动选最低档（关 thinking）
```

> **思考型模型的坑**：桥靠「选最低 reasoning 档」来关 thinking，但这要求宿主模型声明了 reasoning 档位。若你的模型**默认开思考、却没在 profile 里声明 reasoning 元数据**，桥就关不掉它——思考会吃光 BabelDOC 每块仅 2048 的 `max_tokens` 预算，导致约一成多的块返回空内容、整篇回退原文。解决办法是在该模型的 profile 里补上档位与思考格式（以 qwen 为例）：
>
> ```yaml
> models:
>   - id: your-model
>     reasoningEfforts: { off: null, low: "low" }   # off 必须是 null，且至少一个非 off 档
>     compat:
>       thinkingFormat: qwen            # pi-ai 据此发顶层 enable_thinking:false
>       supportsDeveloperRole: false    # 否则 pi-ai 改用 developer 角色，部分端点会 400
> ```
>
> 配好后桥自动选 `off`，实测整篇 80 块零空内容。

### 走第三方 API（`api: "config"`）才需要的 config.toml

`~/.config/babeldoc/config.toml` 模板（BabelDOC 不会自动读它，本插件会显式 `-c` 传入）：

```toml
openai = true
openai-api-key = "sk-***"
openai-base-url = "https://api.example.com/v1"
openai-model = "deepseek-v4-flash"
output = "/home/you/Documents/translated"
lang-in = "en-US"
lang-out = "zh-CN"
watermark-output-mode = "no_watermark"
use-alternating-pages-dual = true
max-pages-per-part = 30
skip-scanned-detection = true
```

> 用 `host`/`auto` 且宿主有模型时，这个文件可以完全不存在。

## 💰 成本

以一篇 8 页论文为基线（deepseek-v4-flash）：

| 场景 | 总 token | 占基线 | 折合 |
| --- | --- | --- | --- |
| 原生 BabelDOC | 238,099 | 100% | ~¥0.33 |
| 本插件，首次（要抽术语） | ~99,385 | 41.7% | ~¥0.14 |
| 本插件，复用词表（实测 43,553） | 43,553 | 18.3% | ~¥0.035 |

实际值受文字量和公式密度影响。

## 🔧 工作原理

### 坑 1：BabelDOC 不读自己的 config

`~/.config/babeldoc/config.toml` 写得好好的，直接跑 `babeldoc paper.pdf` 却报：

```
error: 必须选择一个翻译服务：--openai
```

因为 `babeldoc/main.py` 里的 `configargparse.ArgParser` 既没传 `default_config_files`，`-c/--config` 也没有默认值——**它压根不会自动去找那个文件**。本插件永远显式传 `-c`。

### 坑 2：服务端默认偷偷开 thinking

同一段 1052 字符的正文，同一个 prompt，只改 `extra_body`：

| 请求 | completion | reasoning_tokens | 总 token | 耗时 |
| --- | --- | --- | --- | --- |
| 不传 thinking（默认） | 754 | 585 | 1092 | 9.6s |
| `thinking: disabled` | 174 | 0 | 433 | 3.3s |
| `thinking: enabled` | 1618 | 1449 | 1956 | 15.3s |

默认状态下 **77.6% 的 completion 是推理 token**，而译文长度几乎没变（299 vs 298 字符）。整篇实测更夸张：原生 completion 143,687 里推理占绝大部分，关掉后只剩 9,009。本插件固定传 `--openai-thinking disabled`。

> 术语提取走的是 BabelDOC 里另一个 translator（`term_extraction_translator`），它的 kwargs 根本不含 `thinking`，所以上面这个开关管不到抽词阶段——那部分只能靠复用词表来省。

### 坑 3：术语表本来可以复用，却每篇重抽一遍

8 页论文实测：总 238,099 token，其中术语提取占 55,832。BabelDOC 每次翻译都重新抽一遍。本插件按 `domain` 存表，第二篇同领域论文直接复用，还能回填新增的词。

术语表格式与 BabelDOC 原生一致（`source,target,tgt_lng` 三列带表头），所以拿现成的 `.glossary.csv` 也能直接导入复用。

### 坑 4：产物名猜错，把成功报成「产物不存在」

BabelDOC 0.6.4 的命名分两种：分片合并的最终产物是 `<名>.<语言>.{dual,mono}.pdf`（**不带** `.no_watermark` 段，见 `result_merger.py`），单篇产物才带那段（`pdf_creater.py`）。0.1.1 一律按带段的名字去找，整篇翻译明明成功了却报「预期产物不存在」。现在两套候选都列出来，按存在性 + 修改时间挑本次那份。

### 坑 5：API 全挂了，原文副本冒充译文

BabelDOC 对单段翻译失败是「记日志、继续跑」，**全部失败也退出码 0**，并把原文原样写成「译文」。0.1.1 只看退出码和文件存在，于是把一份英文副本当成功交付。现在跑完用 fitz 抽样页数 CJK 字符（中/日目标语言），低于阈值就报失败，并从日志里识别根因（额度不足 / 401 / 403 / 429 / 断网）给出修复指引——比如「传 `api: "host"` 改用宿主模型」。

## 🧩 依赖

不代装（没有 sudo 也没关系）。缺什么就把准确的修复命令交回来，让你（或模型）决定要不要执行。会检查：

- `babeldoc` 在不在 PATH（也会看 `BABELDOC_BIN` 和 `~/.local/bin/babeldoc`）
- config 能不能读、有没有 `openai = true` 和 `openai-api-key`（**仅 `config` 模式查**；`host` 模式不需要 config，这几项自动跳过）
- **bitstring 版本**：BabelDOC 0.6.4 依赖的 `bitstring` 5.0 移除了 `BitStream`，会直接 `ImportError`。需要 `bitstring>=4.3,<5`：

  ```bash
  uv pip install --python ~/.local/share/uv/tools/babeldoc/bin/python "bitstring>=4.3,<5"
  ```

- API 是否可达（只在 `dryRun` 时探活）

少见的解析失败（`AssertionError: assert total_pages > 0`）是 BabelDOC 对个别 PDF 的兼容问题，不是本插件能修的，换 `--enhance-compatibility` 或换文件。

## 📝 已知限制

- 只处理有文本层的 PDF；扫描件不会自动 OCR。
- 不处理非 PDF。
- 术语表按 `source` + `tgt_lng` 去重（`source` 大小写不敏感），**旧值优先**，新词只增不覆盖。同一个词翻成另一种语言算独立记录。
- 并发默认 2：低余额账户的 API 并发上限只有 3，开 4 会稳定撞 429（`concurrent_request_limit_exceeded`）。
- BabelDOC 默认复用翻译缓存，同一份 PDF 第二次跑是 0 token（结果里会说明）。想重翻就传 `ignoreCache`。
- 成本预估按「页均摊」推，整篇翻译时比较准；只翻前一两页试读时，实测会明显低于预估（首页文字量通常少于平均页）。
- 不做 zathura 划词、批量队列、Web UI——这些是别的插件的地盘。

## 🛠️ 开发

```bash
git clone https://github.com/RyanZhangK/dsh-paper-translate.git
cd dsh-paper-translate

npm test   # node --test test/*.test.mjs，31 个用例（无宿主时跳过依赖宿主的那条）
```

代码结构：

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 注册 `paper_translate` 工具，串起下面几步；按 `api` 决定走桥还是 config |
| `lib/llm-bridge.js` | 本地 OpenAI 兼容桥：把 BabelDOC 请求接到宿主 `ctx.llm`，聚合流式结果、映射 usage 与错误码 |
| `lib/detect.js` | 环境自检（babeldoc / config / key / bitstring / 探活）；host 模式放宽 config；合成 host 临时 config |
| `lib/glossary.js` | 术语表读写、按语言过滤、去重合并、导入 BabelDOC 原生 CSV |
| `lib/estimate.js` | 成本预估常量与格式化 |
| `lib/translate.js` | 拼参数、跑子进程、流式解析用量、双命名产物解析、译文内容验收、日志根因识别 |
| `lib/format.js` | 定宽文本表格：按显示列对齐、超宽截断，不用 `\t` |

测试环境变量 `DSH_PAPER_TRANSLATE_GLOSSARY_DIR` 可以把术语库指到临时目录，避免污染真实数据。

## 📄 许可证

MIT © [RyanZhangK](https://github.com/RyanZhangK)

## 🔗 相关项目

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [BabelDOC](https://github.com/funstory-ai/BabelDOC)
