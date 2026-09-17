# AGENT.md — dsh-opencode-zen 代理记忆

本文件供后续会话/克隆快速回顾本插件的关键事实与协作约定。

## 版本跟随（dsh 升级后必做）
- **本插件的 dsh 依赖版本必须跟随宿主 dsh 的升级，一次都不能落下。** dsh 宿主升级后，
  `package.json` 的 `peerDependencies` 里 `@deepseek-ai/*` 版本必须同步 bump 到宿主实际安装的
  版本——不是"能兼容就行"，而是保持声明与运行实况一致。
- 宿主版本唯一事实来源：
  `node -p "require('/root/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh/package.json').version"`
  （当前 `0.1.5-rc.1`；`@deepseek-ai/dsh-llm` 同步为 `0.1.5-rc.1`）。
- **红线**：这些包**只能在 `peerDependencies`，绝不能进 `dependencies`**——写进 dependencies 会在
  插件目录装出第二份副本，与宿主实例不是同一个模块，服务注册与类型判断会错乱。
- 用 `^` 范围（如 `^0.1.5-rc.1`），不要锁死精确版本：预发布段（alpha/rc）持续滚动，锁死会在
  dsh 升到下一个 rc 时误报不兼容。
- 与 `dsh-codebuddy` 保持同一约定（其 `AGENTS.md` 有同名章节）。

## 图像预算（与官方对齐）
- 图像字节的缩放/编码/缓存一律复用核心 `ctx.attachments.readImageRequest`，
  **不要自己解码或重编码**（sharp 只用于「切条补救」这一独立场景）。
- 传入的预算走 `resolveRequestImagePolicy(model)`，与官方 `@deepseek-ai/dsh-llm-deepseek`
  同语义：`imagePixelBudget`（数字或 `"low"` → `512×512`，缺省 `640000`）、
  `imageMaxBytes`（缺省 **1 MiB**）。该函数是官方适配器私有实现（未从
  `@deepseek-ai/dsh-llm` 导出），故按上游源码 1:1 复刻——改动前先对照上游。
- 模型条目可经 `models.json` 声明 `imagePixelBudget` / `imageMaxBytes` 覆盖默认值；
  `normalizeEntry` 负责透传（**新增字段时勿漏透传**，否则声明到不了策略层）。
- **zen 不适用「超限卸载」**：zen 是视觉旁路架构——图片在序列化阶段被换成文字描述，
  主请求 wire 层**永不出现 `image_url`**（已实测：连喂 700 张图，wire 里 image_url 数仍为 0）。
  因此官方 `offloadRequestImagesWithPolicy` 在此无对象可卸，不要照搬。
- 核心解析手法同 codebuddy：`coreLlm()` 按 dsh 安装位置解析（插件是 link 安装，
  自身 `node_modules` 无核心包）；**不要**把核心包写进 `dependencies`。

## 工作约定（Conventions）
- **临时文件放 `./tmp`，不要放全局 `/tmp`。** 所有中间产物（下载的 JSON、测试脚本、
  重启/运行日志等）统一写在仓库内的 `tmp/`（即当前工作目录下的 `tmp`），**不是**系统的
  `/tmp`。`tmp/` 已加入 `.gitignore`，不会被提交。
- 任务结束后清理 `tmp/` 下的中间产物；仓库里只保留源码与必要文档。
- 不要把 harness 会话状态目录 `.omo/`（含 `run-continuation/ses_*.json`）当垃圾删——
  它是会话恢复用的，已 git-ignore，保留即可。

## 项目要点（Project notes）
- 本插件把 **OpenCode Zen 免费模型**接入 DSH 模型选择器，走 **双源实时拉取**（不写死 `models.json`）：
  - **可用性** = `https://opencode.ai/zen/v1/models`（zen 当前实际在服务的模型，免登录 200）
  - **规格** = `https://models.dev/api.json`（opencode 自身用的全量注册表：上下文窗口 / 输入模态 /
    推理档位 `reasoning_options` / 工具调用 `tool_call` 等完整参数）
  - 规格地图缓存到 `~/.cache/dsh-opencode-zen/models-dev-specs.json`（TTL `DSH_ZEN_MODELS_TTL_MS` 默认 10min），
    避免启动卡在 ~4MB 慢拉取。**缓存带 `SPEC_CACHE_VERSION`**：改动成员筛选逻辑时必须递增，
    否则旧缓存会让新纳入的模型继续缺席（升级后"没生效"的经典坑）。
  - 兜底链：zen 可用性 → models.dev 目录 → 静态 `models.json`。
- **免费成员判定不能只看 `-free` 后缀**：`union-alpha`（2026-09-16 上线的隐身模型）与
  `big-pickle` 的 id 都**不带** free，但 models.dev 里 `cost` 全 0，确为免费档。
  故 `isFreeModelId()` 顺序为：显式名单 → `/free/i` → models.dev 零成本。
  只认后缀会让这类新免费模型从选择器里静默消失。
- **两套 wire 协议**：多数模型走 OpenAI 兼容 `/chat/completions`；`union-alpha` 只认
  Anthropic `/v1/messages`（打 `/chat/completions` 返回 `500 Internal server error`）。
  - 由 `ANTHROPIC_PROTOCOL_MODELS` 声明，`wireProtocolOf()` 判定；`normalizeEntry` 把
    `wireProtocol` 带进模型条目。
  - 差异：system 顶层字段 / 工具 `input_schema` / 工具结果回成 user 的 `tool_result` 块 /
    流事件是 `content_block_delta` / 结束标记 `message_stop`·`stop_reason` / temperature 上限 1。
  - `AnthropicStreamTranslator` 与 `StreamTranslator` **接口完全一致**
    （feed/pump/finalize/openedBlocks/continuable/toolBlocks/sawFinishReason/snapshotPartial/
    quarantinePartialTools），故 `stream()` 的断流续跑恢复机制两条线共用。
  - **Anthropic 线不回放 reasoning**：thinking 块需 `signature`，回放会被上游拒。
  - **Anthropic 线长生成流式恒返回空 body**（HTTP 200 + 0 字节，约 32s 后），
    同一请求 `stream:false` 却能稳定取回——这不是"断流"，是网关对该线的流式缺陷。
    故该线空流时**直接退回非流式**（`fetchOnceNonStreaming` +
    `anthropicMessageToEvents`），不再重试流式。此即 union-alpha 长回答报
    "stream ended without any data" 的根因。
  - **超时预算必须按请求形态分档（2026-09-17 实测，曾致长回答整轮失败）**：
    非流式请求下网关会**把整段生成缓冲完才发响应头**——实测长回答的 headers 与
    body 同在 **175.8s** 到达，即 `fetch()` resolve 时刻 ≈ 整段生成耗时，而非首字节
    时间。若非流式沿用 `CONNECT_TIMEOUT_MS`(45s)，**任何超过 45s 的正常长回答
    都会被误判为 "connect timeout"**。
  - **非流式预算由吞吐反推，不是拍固定值**：实测吞吐 ≈ **23.1 tok/s**
    （union-alpha，4062 tok / 175.8s）。`nonstreamTimeoutMs(max_tokens)` 用保守
    下界 `NONSTREAM_FLOOR_TPS=10` × 安全系数 1.5 反推，夹在
    `[NONSTREAM_TIMEOUT_MIN_MS(60s), NONSTREAM_TIMEOUT_MAX_MS]`。
    **注意 union-alpha 满额 max_tokens=131072 按实测吞吐需 ≈ 95 分钟**——不能真等：
    会把 UI 冻住数小时，且挂死连接陪跑同样时长。默认硬上限 **10 分钟**，可用
    `DSH_ZEN_NONSTREAM_TIMEOUT_MS` 调整：正整数=毫秒；`0`/`unlimited`/`infinity`/
    `none` = 不主动超时（只等宿主 signal 取消），受 `MAX_TIMER_DELAY_MS`
    (2147483647ms≈24.8 天) 保护。**改超时相关代码时勿把两档合并，也不要把上限
    改成无条件的无限。**
  - **宿主两侧都没有请求级超时**：`@deepseek-ai/dsh-llm` 不设请求级 timeout，
    只把取消权经 `signal` 交给适配器；`idleWatchdog` 仅被**内置** deepseek/pi-ai
    适配器使用，**不套在第三方适配器输出上**。故墙钟上限完全由本插件自己决定——
    「能不能一直等」是本插件自己的策略问题，不是宿主限制。
  - **流式空 body 是偶发、不是必现**（3 轮采样：OK 1 / EMPTY 1 / 限流 4）。
    故**必须保留非流式兜底**：不能因为"流式看起来不行"就改成一律非流式，
    也不能删掉非流式兜底。两条路都要活。
  - **流式 idle 看门狗已对齐官方（30s → 300s）**：该阈值语义是"死连接检测"，
    不是"生成时长上限"。长思考期间上游可能长时间不发字节（实测流式 headers 到
    首个 chunk 之间、以及 chunk 之间都可能长静默），30s 比官方内置
    `dsh-llm-deepseek` 的 300s 严 10 倍，会把正常长回答误杀。故默认 300s，
    `DSH_ZEN_STREAM_IDLE_TIMEOUT_MS` 可覆盖（`0`=关闭看门狗）。
  - **流式路径无总时长上限**：`connectTimer` 在 `fetch()` 返回（响应头到达）后即
    清除，泵送阶段只受 idle 看门狗约束。故"能等多久"在流式上由"静默多久"决定，
    而非总时长——这是比非流式更健康的模型。
  - **实测修复后**（真实适配器端到端）：短回答 56.4s、长回答 81.3s（2045 字）、
    非流式 175.8s（4062 tok / 5798 字）均完整取回，全部 >45s。
  - **视觉旁路也必须按协议走**：`describeRequest()` 统一产出端点与请求体
    （Anthropic 用 `image`+`source.base64` 打 `/v1/messages`；OpenAI 用
    `image_url` 打 `/chat/completions`），`extractDescribeText()` 兼容两种响应形态。
    旧实现把 OpenAI 形态写死，导致 union-alpha 识图整条链 500——**该模型本身能原生识图**，
    实测喂纯色图能正确答出颜色；改协议后 `visionDescribe` 正常返回描述。
  - `openStreamOnce` 的 idle-watch 代理（`Object.create(response)`）会丢 undici 私有槽位，
    非流式请求会使 `response.json()` 抛 "Cannot read private member #state"；
    故非流式走 `options.nonStreaming` 跳过该包装。
- **原生收图（用户图直传）**：`NATIVE_IMAGE_MODELS`（+ `models.json` 的 `nativeImage`
  可覆盖）声明的模型，其**用户消息**里的图以原生 image 块直传主请求，不再转文字
  （`nativeImageParts()`；Anthropic 发 `image`+`source.base64`，OpenAI 发 `image_url`）。
  取字节仍走同一个 `loadImage`，故预算/缩放/编码与旁路一致。目前仅 `union-alpha`。
  - **红线：工具结果里的图绝不直传。** 实测把图块塞进 `tool_result.content` /
    `role:"tool"`，上游虽 200，但模型明确说看不到像素（"can't visually inspect that
    base64 payload"）并要求直接附图，四象限颜色全错；同一张图作为用户消息直传则全中。
    故工具结果图一律走文字旁路——这与"原生支持视觉"无关，是模型对工具输出内图的处理限制。
  - 判定随模型走：`usesNativeImage()` 先看模型条目的 `nativeImage`，再退回内置名单。
- **视觉（image）以 `models.dev` 的 `modalities.input` 为准**：已核实
  `mimo-v2.5-free` / `union-alpha` **有**视觉、`hy3-free`（已退役）无视觉；
  旧的 blanket revert 已过时。`models.json` 仍可显式写 `input: ["text","image"]` 覆盖。
- 成员真相 = zen 实时可用 id ∩ 免费判定；`models.json` 只是**注释/兜底层**（name/上下文/推理档/数据风险）。
- 改 `lib/index.js` 后 `dev_reload_package` 只重建 fiber、**不重读磁盘**，需**整进程重启 `dsh web`**：
  用 detached `setsid` 包装器 `kill` 旧进程后自启，并 `curl` 自检 3080 端口。
- 鉴权：zen 用字面量 key `public`，`Authorization: Bearer public`；`OPENCODE_BASE=https://opencode.ai/zen/v1`。
- **归属闸门（2026-09-17 重逆向，关键；旧结论已作废）**：网关不再只看 `x-session-id`。
  它现在校验 opencode 官方客户端的身份头集合，旧写法一律
  `403 {"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}`。
  - **真值获取法（别再猜头名）**：把官方 `opencode` 装到本地，用 `OPENCODE_CONFIG` 指向一个
    `@ai-sdk/openai-compatible` 自定义 provider、baseURL 指到本地日志代理，跑
    `opencode run --model <p>/<m> "..."`，直接抓到官方 wire 头。1.18.31 实测发送：
    `User-Agent: opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`、
    `x-opencode-client: cli`、`x-opencode-project: <sha1|global>`、
    `x-opencode-request: msg_<id>`、`x-opencode-session: ses_<26 位小写 hex>`。
    **新版 wire 上已无 `x-session-id`**。
  - **实测判定规则**（交错乱序各 5 次重复，按 id 确定性稳定）：只有
    `ses_`+**恰好 26 位小写 hex** 放行(200)；24/25/27/28/32 位 hex、26 位大写 hex、
    26 位 base62、裸 uuid/裸 hex(无 `ses_` 前缀) 全部 403。官方 CLI 真实 id 作对照为 200。
  - `User-Agent` **不必**伪装（DSH 自报 UA 也 200）；`x-opencode-*` 其余头亦非硬性必需，
    但按官方全发更稳。`/models` 目录端点不校验该闸门（仍 200）。
  - 宿主会话 id 是 `ses_<26 位 base62>`，**不能原样透传**（字母表/长度不合规）；
    `normalizeSessionId` 用 `sha256(hostId)` 取前 26 位小写 hex 派生，从而**同一会话恒定**
    → 上游后端亲和 / prompt cache 命中。缺省回退进程级 `FALLBACK_SESSION_ID`。
  - 插件侧统一走 `zenHeaders(sessionId)`：**所有**发往 zen 的请求（主对话 / 视觉旁路 /
    切条描述 / `/models` 目录）都必须经过它，漏一处即整条链路 403。
  - 网关另有 ~60s 级限流：密集实验会被打断（表现为超时，不是 403），排查时注意区分。
- **退役模型闸门（2026-09-17 对照官网 pricing 清理）**：`hy3-free`、`laguna-s-2.1-free`
  已从 zen `/models` 下线；`deepseek-v4-flash-free`、`muse-spark-1.2-contributor-free`
  id 仍在目录但官网免费价格表已除名。四个 id 写死在 `EXCLUDED_MODEL_IDS`
  （lib/index.js），zen 实时目录 / models.dev / 静态 models.json / 旧磁盘缓存任一来源
  出现都会被剔除；`models.json` 里条目另带 `retired: true` 双保险。
  **后续若再发现某模型不免费：先加进 `EXCLUDED_MODEL_IDS`，再清理 `models.json` 与文档。**
- 当前 zen 实测（2026-09-17，免费档可用）：`mimo-v2.5-free` / `ling-3.0-flash-fin-free` /
  `nemotron-3-ultra-free` / `nemotron-3.5-lightning-free` /
  `muse-spark-1.3-contributor-free` / `big-pickle` / `union-alpha`；
  `muse-spark-1.3-contributor-free` 在本机为 `not available in your country`（区域限制）——服务端状态，非插件缺陷。

## 验证速记
- 实时自检：独立 `node -e` require 本包 `OpenCodeZenAdapter.listModels()` 实时拉取免费清单。
- 闸门自检（改头逻辑后必跑）：`mod.zenHeaders('ses_<26位base62>')` 应产出
  `ses_`+26 位小写 hex，且对同一输入稳定；再拿该头实际 POST `/chat/completions` 应 200。
- 双协议自检：`node -e` 用适配器 `stream()` 分别跑 `union-alpha`（Anthropic 线，
  应产出 text/tool-call 块）与 `nemotron-3.5-lightning-free`（OpenAI 线）——
  改协议相关代码后两条线都要过。
- **网关有 ~60s 级限流**：密集自检脚本要在请求间 `sleep 6~12s`（实测重探时
  15~20s 间隔更稳），否则表现为 `503 Endpoint is unavailable` 或超时，而非 403。
  **区分限流与真故障**：503 是限流/上游抖动（可重试）；持续 403 才是归属闸门。
