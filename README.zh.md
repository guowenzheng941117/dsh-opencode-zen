# dsh-opencode-zen

**0 元接入 OpenCode Zen 免费大模型** —— 把 OpenCode Zen 免费档模型装进 DeepSeek Harness，零配置、免注册、免充值，装完即用。

[English](README.md)

---

## 为什么用这个插件？

你正在看的这段对话，就是由它驱动的：**OpenCode Zen 免费档，零配置、零花费。**

- 💰 **真免费** —— 官方免费档用字面量 key `public` 认证，不需要注册、不需要充值、不需要 API Key
- 🎫 **按网关规矩来** —— zen 免费档只服务"看起来像官方 opencode CLI"的客户端。插件在每次请求上盖齐整套身份头，其中 `x-opencode-session` 严格是 `ses_` + 26 位小写 hex —— 这是网关真正校验的唯一字段（从官方客户端实测逆向得出，见下文"归属闸门"）
- 🧮 **实时免费清单** —— 可用免费模型在运行时从 OpenCode Zen 的 `/v1/models` 端点拉取（免登录即可），选择器永远反映当前实际提供的模型；`models.json` 仅作为元数据注释层
- ⚡ **即装即用** —— 装完重启 `dsh web`，模型选择器里直接多出 `opencode` 路由，无需任何配置
- 🔑 **额度叠加** —— 配合 dsh-api-key-pool 多 Key 轮换，多个免费账号额度自动叠加、自动切换
- 🛡️ **额度友好** —— 内置 429/5xx 退避重试与请求节流，不会一把打爆免费额度
- 🔁 **断流自愈** —— 免费档网关会在长生成中单方面掐流（无报错、无答案）：思考/正文被掐按递增间隔自动续跑，同一个思考块无缝衔接；工具调用参数被掐则把残参隔离成合法占位（宿主得到明确校验错误而非静默失败）并整轮重试
- 🖼️ **识图不断链** —— 图片从不进入主请求：每张图经一次独立的一次性旁路请求换取文字描述（失败自动重派全新请求，按内容哈希缓存、每轮复用），上游视觉端点再不稳定也只是这张图降级为占位符，主会话永不被毒化
- 🧠 **能力齐全** —— 流式输出、推理内容（reasoning）透传、工具调用，和付费模型体验一致

## 模型列表（运行时实时发现）

免费模型清单**不再写死** —— 从两个 API 源实时拉取并合并：

- **可用性** = `https://opencode.ai/zen/v1/models`（OpenAI 兼容列表，免登录）。这是 zen 当前**实际在服务的**模型，只有能用的才会出现。
- **规格** = `https://models.dev/api.json`（opencode 自身也在用的全量注册表），为每个模型带来**上下文窗口、输入模态（text/image/audio/pdf）、推理档位、工具调用支持**等完整参数。

规格地图会缓存到磁盘（`~/.cache/dsh-opencode-zen/models-dev-specs.json`，TTL `DSH_ZEN_MODELS_TTL_MS`，默认 10 分钟），所以启动不会卡在那 ~4MB 的 models.dev 拉取。某源失败时逐级兜底：zen → models.dev 目录 → 静态 `models.json`。当前实时集合（可用性 ∩ 规格）：

| 模型 | 备注 |
|---|---|
| `deepseek-v4-flash-free` | DeepSeek V4 Flash · 推理 + 工具调用，日常主力 |
| `mimo-v2.5-free` | 小米 MiMo 2.5 |
| `ling-3.0-flash-fin-free` | 蚂蚁 Ling 3.0 Flash Fin |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Contributor |
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 Contributor |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra（1M 上下文） |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning |

截至 2026-09-17，免费档只剩这 7 个 —— `hy3-free` 与 `laguna-s-2.1-free` 已从 zen 下线。
由于成员是实时拉取的，该表仅作示意、非权威：选择器由 `/v1/models` 驱动，
上架/下架会自行反映。

若实时拉取失败，插件回退到静态 `models.json`，选择器仍可离线工作。上游下架的模型自动消失，新上的模型无需更新插件即可出现。

选择器统一提供 `off` / `low` / `high`（默认）/ `max` 四档；插件按各模型能力翻译后发送，不支持的档位自动收敛或不发该字段。

## 归属闸门

zen 免费档不服务第三方客户端：请求若不像官方 opencode CLI 发出的，一律被拒：

```json
{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```

插件通过发送与官方客户端一致的身份头来通过闸门。我们**不靠猜头名，而是直接截获官方客户端**：
装好 `opencode`，用 `OPENCODE_CONFIG` 把一个 `@ai-sdk/openai-compatible` provider 的
baseURL 指向本地日志代理，跑 `opencode run`。1.18.31 实际发送：

| 头 | 值 |
|---|---|
| `User-Agent` | `opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` |
| `x-opencode-client` | `cli` |
| `x-opencode-project` | 项目 id（sha1）——填 `global` 也可 |
| `x-opencode-request` | `msg_<id>`（取值不校验） |
| `x-opencode-session` | `ses_<26 位小写 hex>` |

插件以前依赖的 `x-session-id` **已从新版客户端的 wire 格式中消失**。

实测只有 **`x-opencode-session` 的形态**被校验。交错乱序、多次重复实验下，判定按值确定性：

| `x-opencode-session` | 结果 |
|---|---|
| `ses_` + 恰好 26 位小写 hex | **200** |
| `ses_` + 24 / 25 / 27 / 28 / 32 位 hex | 403 |
| `ses_` + 26 位**大写** hex | 403 |
| `ses_` + 26 位 base62 字符 | 403 |
| 裸 UUID / 裸 hex（无 `ses_` 前缀） | 403 |
| 官方 CLI 真实会话 id（对照） | 200 |

`User-Agent` 不必伪装成 opencode（DSH 自报 UA 也能过），但插件仍按官方值发送。
宿主自己的会话 id 是 `ses_<26 位 base62>`，不能原样透传；插件用 SHA-256 从它派生出
**稳定的** `ses_<26 位小写 hex>`，使同一会话的每一轮都钉在同一上游后端、保住 prompt cache。

## 安装

```sh
dsh plugin --profile web add github:guowenzheng941117/dsh-opencode-zen
```

重启 `dsh web` → **设置 → 模型** → 选择提供器 `opencode` → 挑一个免费模型（推荐 `nemotron-3.5-lightning-free`），开聊。

## 配置（可选，默认零配置）

### 多账号额度叠加（推荐）

1. 安装 [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool)
2. 在它的 pool 配置里为 `opencode` 添加你的多个 key
3. 插件自动读取并轮换使用，多账号免费额度叠加

### 环境变量

启动 `dsh web` 前设置 `OPENCODE_ZEN_API_KEY` 或 `OPENCODE_GO_API_KEY` 即可。

什么都不配也行——插件最终兜底到官方公开档 `public`。

### 注释模型清单（可选）

免费模型已实时从 API 发现，通常你无需改动任何东西。根目录 `models.json` 是一层**按 id 的注释层** —— 用来补充 `/v1/models` 列表不返回的元数据（名称、上下文窗口、推理档位、图片输入、数据风险）。它接受 `{ "models": [...] }` 或裸数组，每项至少要有字符串 `id` 字段：

```json
{ "id": "hy3-free", "name": "Hunyuan 3 (Free)", "contextWindow": 190000, "reasoningEfforts": ["low", "high"] }
```

- `reasoningEfforts`：数组 = 该模型接受的推理档位词汇；`null` / `false` = 不发送显式控制
- `input`：`["text","image"]` 为该模型开启视觉
- 文件缺失或损坏时，回退到内置默认表

## 常见问题

**Q: 模型返回 429 Too Many Requests 怎么办？**
A: 免费档有按 IP 的速率限制。等 30–60 秒再试，或者安装 [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool) 自动轮换多个 Key。

**Q: 模型选择器里没有 `opencode` 提供器？**
A: 完全重启 `dsh web`（不是只刷新页面）。用 `dsh plugin --profile web list` 确认插件已安装。

**Q: 支持哪些 DSH 版本？**
A: DSH 0.8.0+（需要 `ctx.llm.registerAdapter` API）。旧版本可能需要手动注册路由。

**Q: 这些模型真的永久免费吗？**
A: 使用的是 OpenCode Zen 官方公开免费档。服务可用性和额度限制以 OpenCode Zen 官方政策为准——本插件只是一个客户端适配器。

## 原理

通过 `ctx.llm.registerAdapter(['opencode'], adapter)` 注册 LLM 提供器路由，把 OpenCode Zen 免费模型挂进 DSH 模型体系，会话模型、子代理都能用。

## 许可

MIT
