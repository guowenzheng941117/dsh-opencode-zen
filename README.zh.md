# dsh-opencode-zen

**0 元接入 OpenCode Zen 免费大模型** —— 把 OpenCode Zen 免费档模型装进 DeepSeek Harness，零配置、免注册、免充值，装完即用。

[English](README.md)

---

## 为什么用这个插件？

你正在看的这段对话，就是由它驱动的：**OpenCode Zen 免费档，零配置、零花费。**

- 💰 **真免费** —— 官方免费档用字面量 key `public` 认证，不需要注册、不需要充值、不需要 API Key
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
| `hy3-free` | 腾讯混元 Hy3 |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash · 推理 + 工具调用，日常主力 |
| `mimo-v2.5-free` | 小米 MiMo 2.5 |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Contributor |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning |
| `laguna-s-2.1-free` | Laguna S 2.1 |

若实时拉取失败，插件回退到静态 `models.json`，选择器仍可离线工作。上游下架的模型自动消失，新上的模型无需更新插件即可出现。

选择器统一提供 `off` / `low` / `high`（默认）/ `max` 四档；插件按各模型能力翻译后发送，不支持的档位自动收敛或不发该字段。

## 安装

```sh
dsh plugin --profile web add github:guowenzheng941117/dsh-opencode-zen
```

重启 `dsh web` → **设置 → 模型** → 选择提供器 `opencode` → 挑一个免费模型（推荐 `x-preview-f-free`），开聊。

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
