# AGENT.md — dsh-opencode-zen 代理记忆

本文件供后续会话/克隆快速回顾本插件的关键事实与协作约定。

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

## 验证速记
- 离线合并测试：`node tmp/test_merge.js`（需先放好 `tmp/models_api.json` 与 `tmp/zen_models.json`）。
- 实时自检：独立 `node -e` require 本包 `OpenCodeZenAdapter.listModels()`，期望 7 个 free 模型且
  `mimo`/`muse-spark` 的 `inputModalities` 含 `image`、`hy3` 仅 `text`。
