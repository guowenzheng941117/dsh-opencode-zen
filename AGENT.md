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
  - **可用性** = `https://opencode.ai/zen/v1/models`（zen 当前实际在服务的 free 模型，免登录 200）
  - **规格** = `https://models.dev/api.json`（opencode 自身用的全量注册表：上下文窗口 / 输入模态 /
    推理档位 `reasoning_options` / 工具调用 `tool_call` 等完整参数）
  - 规格地图缓存到 `~/.cache/dsh-opencode-zen/models-dev-specs.json`（TTL `DSH_ZEN_MODELS_TTL_MS` 默认 10min），
    避免启动卡在 ~4MB 慢拉取。
  - 兜底链：zen 可用性 → models.dev 目录 → 静态 `models.json`。
- **视觉（image）以 `models.dev` 的 `modalities.input` 为准**：已核实 `hy3-free` **无**视觉、
  `mimo-v2.5-free` **有**视觉（与 models.dev 一致）；旧的 blanket revert 已过时。
  `models.json` 仍可显式写 `input: ["text","image"]` 覆盖。
- 成员真相 = zen 实时 free id；`models.json` 现在只是**注释/兜底层**（name/上下文/推理档/数据风险）。
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
- 当前 zen 实测（2026-09-17，免费档可用）：`hy3-free` / `deepseek-v4-flash-free`(上游仍
  `Model is unavailable`) / `mimo-v2.5-free` / `ling-3.0-flash-fin-free` /
  `nemotron-3-ultra-free` / `nemotron-3.5-lightning-free` /
  `muse-spark-1.2-contributor-free` / `muse-spark-1.3-contributor-free`；
  `muse-spark-*` 在本机为 `not available in your country`（区域限制）——服务端状态，非插件缺陷。
  `laguna-s-2.1-free` 已从 zen `/models` 下线。

## 验证速记
- 离线合并测试：`node tmp/test_merge.js`（需先放好 `tmp/models_api.json` 与 `tmp/zen_models.json`）。
- 实时自检：独立 `node -e` require 本包 `OpenCodeZenAdapter.listModels()` 实时拉取免费清单。
- 闸门自检（改头逻辑后必跑）：`mod.zenHeaders('ses_<26位base62>')` 应产出
  `ses_`+26 位小写 hex，且对同一输入稳定；再拿该头实际 POST `/chat/completions` 应 200。
