'use strict'
/**
 * dsh-opencode-zen — OpenCode Zen 免费模型接入插件（服务端）
 *
 * 原理：通过 ctx.llm.registerAdapter(['opencode'], adapter) 注册一个
 * provider 路由，让 OpenCode Zen 的免费模型出现在 DSH 模型选择器里。
 *
 * - 免费模型用字面量 key "public" 认证（服务商官方免费档，无需注册）
 * - 若在 key pool (pool-config.json) 里为 opencode 配置了多个 key，
 *   自动轮换使用（多账号额度叠加）
 * - 支持流式输出、reasoning_content（推理内容）透传、tool calls
 * - 断流自愈：免费档网关会在长思考中单方面掐流（无 [DONE]/finish_reason），
 *   插件识别无声中断后按递增间隔自动续跑，UI 无感衔接
 * - 内置简易 429/5xx 退避与请求节流，防止打爆免费额度
 *
 * 注入：llm（注册 adapter）
 */

const { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { createHash, randomUUID, randomBytes } = require('node:crypto')
const { join, dirname } = require('node:path')
const { createRequire } = require('node:module')
const { homedir } = require('node:os')
const name = 'dsh-opencode-zen'
const inject = ['llm']

const PROVIDER = 'opencode'
const OPENCODE_BASE = 'https://opencode.ai/zen/v1'
const OPENCODE_UA = 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const POOL_FILE = join(homedir(), '.dsh', 'profiles', 'web', 'plugins', 'dsh-api-key-pool', 'pool-config.json')

const MODELS_FILE = join(__dirname, '..', 'models.json')

/** 内置默认表：仅当 models.json 缺失或损坏时兜底使用 */
const DEFAULT_MODELS = [
  { id: 'union-alpha', name: 'Union Alpha (Free)', contextWindow: 262144, maxTokens: 131072, description: 'OpenCode Zen 免费档（隐身模型，Anthropic /v1/messages 协议，支持工具与视觉）', input: ['text', 'image'] },
  { id: 'big-pickle', name: 'Big Pickle (Free)', contextWindow: 200000, maxTokens: 32000, description: 'OpenCode Zen 免费档（OpenAI 兼容协议）' },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)', contextWindow: 200000, maxTokens: 128000, description: 'OpenCode Zen 免费档：推理 + 工具调用，日常主力' },
  { id: 'mimo-v2.5-free', name: 'MiMo 2.5 (Free)', contextWindow: 200000, maxTokens: 32000, description: 'OpenCode Zen 免费档（小米 MiMo 2.5，支持视觉）', input: ['text', 'image'] },
  { id: 'hy3-free', name: 'Hunyuan 3 (Free)', contextWindow: 190000, maxTokens: 64000, description: 'OpenCode Zen 免费档（腾讯混元）' },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin (Free)', contextWindow: 262144, maxTokens: 32768, description: 'OpenCode Zen 免费档（蚂蚁 Ling 3.0 Flash Fin）' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (Free)', contextWindow: 1000000, maxTokens: 128000, description: 'OpenCode Zen 免费档（NVIDIA，百万上下文）' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (Free)', contextWindow: 262144, maxTokens: 262144, description: 'OpenCode Zen 免费档（NVIDIA）' },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Contributor (Free)', contextWindow: 1048576, maxTokens: 131072, description: 'OpenCode Zen 免费档（Muse Spark 1.2 贡献者，支持视觉）', input: ['text', 'image'] },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Contributor (Free)', contextWindow: 1048576, maxTokens: 131072, description: 'OpenCode Zen 免费档（Muse Spark 1.3 贡献者，支持视觉）', input: ['text', 'image'] },
]

/**
 * 模型清单外置化：优先读取插件根目录的 models.json（接受
 * { "models": [...] } 或裸数组；每项至少要有字符串 id 字段），
 * 文件缺失、JSON 损坏或条目不合法时回退到内置 DEFAULT_MODELS。
 * 编辑 models.json 后重启 dsh web 生效。
 */
function loadModels() {
  try {
    if (existsSync(MODELS_FILE)) {
      const raw = JSON.parse(readFileSync(MODELS_FILE, 'utf8'))
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : null
      if (Array.isArray(list) && list.length > 0 && list.every((m) => m && typeof m.id === 'string' && m.id.length > 0)) {
        return list
      }
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_MODELS
}

const MODELS = loadModels()

const MODELS_DEV_URL = 'https://models.dev/api.json'

/**
 * zen 免费档的"入场券"（2026-09-17 重新逆向，关键）。
 *
 * 旧结论（已过时）：网关只要 `x-session-id: <任意非空>`。
 * 现状：网关改为校验 opencode 官方客户端的身份头集合，旧写法一律
 * `403 FreeTierError — OpenCode's free tier can only be used from within OpenCode`。
 *
 * 真值获取法（不再靠猜头名）：把官方 opencode 装到本地，用 OPENCODE_CONFIG
 * 指向一个 baseURL 为本地日志代理的 @ai-sdk/openai-compatible provider，跑
 * `opencode run --model <p>/<m>`，即可抓到官方 wire 上的完整头集合。1.18.31 实测发送：
 *   user-agent:         opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
 *   x-opencode-client:  cli
 *   x-opencode-project: <项目 id 的 sha1>（`global` 亦可）
 *   x-opencode-request: msg_<id>
 *   x-opencode-session: ses_<26 位小写 hex>
 * 注意新版 wire 上已没有 `x-session-id`。
 *
 * 实测判定规则（交错乱序各 5 次重复，结果按 id 确定性稳定）：
 *   ses_ + 恰好 26 位小写 hex → 200 ✅（多轮独立实验全 200）
 *   ses_ + 24/25/27/28/32 位  → 403 ❌
 *   ses_ + 26 位大写 hex      → 403 ❌
 *   ses_ + 26 位 base62 随机  → 403 ❌
 *   裸 uuid / 裸 hex          → 403 ❌
 * 结论：**唯一必须精确满足的就是 x-opencode-session 的 `ses_`+26 位小写 hex 形态**；
 * User-Agent 无论用 opencode 还是 dsh 自报都能 200，`x-opencode-*` 其余头亦非必需
 * （一并带上更贴近官方、更稳）。因此这里按官方五件套全发。
 *
 * 宿主会话 id 不能直接透传：它是 `ses_<26 位 base62>`，长度与字母表都不合规，
 * 必须重新规整成 26 位小写 hex。为保住上游 prompt cache 的后端亲和，同一宿主
 * 会话必须映射到**同一个**下游 id（按原 id 做 sha256 派生，天然满足），
 * 未知/缺失会话才退回进程级随机兜底 id。
 */
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{26}$/

/** 26 位小写 hex：13 字节 → 26 个 hex 字符 */
function randomSessionHex() {
  return randomBytes(13).toString('hex')
}

/** 进程级兜底会话 id：宿主未提供 sessionId 时使用（同一进程内稳定，保归因/亲和一致） */
const FALLBACK_SESSION_ID = `ses_${randomSessionHex()}`

/** 由任意宿主 id 派生出稳定的 26 位小写 hex（同会话必定同结果，保 prompt cache 亲和） */
function deriveSessionHex(raw) {
  return createHash('sha256').update(String(raw)).digest('hex').slice(0, 26)
}

/**
 * 把宿主会话 id 规整成下游要求的 wire 形态。
 * - 已是合规 `ses_`+26 小写 hex → 原样透传
 * - 其它任何非空 id → 用 sha256 派生成 26 位小写 hex（稳定、可复用）
 * - 缺失/空 → null（调用方退回进程级兜底 id）
 */
function normalizeSessionId(raw) {
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  if (!id) return null
  if (OPENCODE_SESSION_RE.test(id)) return id
  return `ses_${deriveSessionHex(id)}`
}

/** 归属/亲和头用的次要 id（网关不校验其取值，仅需稳定且形如官方） */
function randomHex(n) {
  return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n)
}

/**
 * 组装 zen 请求头。所有发往 zen 的请求（主对话 / 视觉旁路 / 切条描述 /
 * 目录拉取）都必须经过这里，确保身份头一处不漏——漏一个就是整条链路 403。
 * 目录拉取(`/models`)不校验该闸门，但共用同一实现以免漏改。
 */
function zenHeaders(sessionId) {
  const sid = normalizeSessionId(sessionId) || FALLBACK_SESSION_ID
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${resolveApiKey()}`,
    'User-Agent': OPENCODE_UA,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-request': `msg_${randomHex(26)}`,
    'x-opencode-session': sid,
    // 兼容仍认旧头的中间层/旧网关；新网关已忽略该头
    'x-session-id': sid,
  }
}

/**
 * 模型目录成员判定。zen 的免费档绝大多数用 `*-free` 后缀，但**个别免费模型没有后缀**
 * （如 `union-alpha`：models.dev 里 name 为 "Union Alpha Free"、cost 全 0，但 id 不带 free）。
 * 因此不能只靠后缀正则，否则新免费模型会自动从选择器里消失。
 * 判定顺序：显式名单 → /free/i 后缀 → models.dev 声明的零成本。
 */
const FREE_IDS_WITHOUT_SUFFIX = new Set(['union-alpha'])

/** 走 Anthropic `/v1/messages` 协议而非 OpenAI `chat.completions` 的模型。
 *  zen 对同一网关暴露两种协议；这两个模型只认 Anthropic 线格式
 *  （`/chat/completions` 会 500 Internal server error）。 */
const ANTHROPIC_PROTOCOL_MODELS = new Set(['union-alpha'])

/** 该模型该走哪条 wire 协议：'anthropic' | 'openai' */
function wireProtocolOf(model) {
  return model && ANTHROPIC_PROTOCOL_MODELS.has(model.id) ? 'anthropic' : 'openai'
}

function isFreeModelId(id, spec) {
  if (typeof id !== 'string' || !id) return false
  if (FREE_IDS_WITHOUT_SUFFIX.has(id)) return true
  if (/free/i.test(id)) return true
  const c = spec?.cost
  return !!(c && Number(c.input) === 0 && Number(c.output) === 0)
}

/**
 * models.dev 注册表较大（~4MB）且服务端较慢；把解析后的 free 规格地图缓存到磁盘，
 * TTL 内直接命中（毫秒级），避免每次启动/刷新都阻塞 ~2 分钟拉取。
 * CACHE_VERSION：成员筛选逻辑变更时递增，令旧缓存立即失效——否则升级插件后，
 * 仍在 TTL 内的旧缓存会让新纳入的免费模型（如无 free 后缀的 union-alpha）继续缺席。
 */
const MODELS_DEV_CACHE = join(homedir(), '.cache', 'dsh-opencode-zen', 'models-dev-specs.json')
const SPEC_CACHE_VERSION = 2
function loadSpecCache() {
  try {
    if (existsSync(MODELS_DEV_CACHE)) {
      const c = JSON.parse(readFileSync(MODELS_DEV_CACHE, 'utf8'))
      if (c && c.map && c.version === SPEC_CACHE_VERSION && Date.now() - (c.fetchedAt || 0) < LIVE_TTL_MS) return c.map
    }
  } catch { /* ignore */ }
  return null
}
function saveSpecCache(map) {
  try {
    const dir = dirname(MODELS_DEV_CACHE)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(MODELS_DEV_CACHE, JSON.stringify({ version: SPEC_CACHE_VERSION, fetchedAt: Date.now(), map }))
  } catch { /* best effort */ }
}

/**
 * 实时模型目录（API 拉取，双源合并）：
 *  - 可用性（成员真相）= zen 的 `${OPENCODE_BASE}/models`（OpenAI 兼容列表，免登录即 200）
 *    返回"当前 zen 实际在服务的 free 模型"，是能否真正对话的权威来源。
 *  - 规格（上下文/模态/推理档/工具调用…）= models.dev 全量注册表 `api.json`
 *    （opencode 自身也用它；含 limit.context、modalities.input、reasoning_options 等）。
 *  两者合并：只暴露 zen 当前在服务的 free 模型，并带 models.dev 拉来的完整规格。
 *  拉取失败逐级兜底：zen 可用性 → models.dev 目录 → 静态 models.json，保证离线也可用。
 */
let _liveModels = null
let _liveFetchAt = 0
let _liveFetching = null
const LIVE_TTL_MS = Math.max(1000, Number(process.env.DSH_ZEN_MODELS_TTL_MS) || 10 * 60 * 1000)

/** 从 models.dev 的 reasoning_options 抽取该模型接受的推理档位词汇；无 effort 档位则返回 null（不发显式控制） */
function extractReasoningEfforts(spec) {
  const opts = spec?.reasoning_options || []
  const eff = opts.find((o) => o && o.type === 'effort' && Array.isArray(o.values))
  return eff ? eff.values : null
}

/** 由 models.dev 规格 + models.json 注释层合并出插件内部模型条目 */
function normalizeEntry(id, spec, staticEntry) {
  const s = staticEntry
  const modIn = spec?.modalities?.input || []
  const image = Array.isArray(modIn) && modIn.includes('image')
  return {
    id,
    name: s?.name || spec?.name || id,
    contextWindow: s?.contextWindow || spec?.limit?.context || DEFAULT_CONTEXT_WINDOW,
    description: s?.description || spec?.description || 'OpenCode Zen 免费档（实时拉取）',
    // 上游线协议：anthropic = 走 /v1/messages，openai = 走 /chat/completions
    ...(wireProtocolOf({ id }) === 'anthropic' ? { wireProtocol: 'anthropic' } : {}),
    // 推理档位：models.json 显式覆盖优先；否则取 models.dev 的 effort 档位；无则 null（不发显式控制）
    reasoningEfforts: s && 'reasoningEfforts' in s ? s.reasoningEfforts : extractReasoningEfforts(spec),
    // 视觉：以 models.dev 的 modalities.input 为准（已核实 hy3 无视觉、mimo 有视觉，与 models.dev 一致；
    // 旧的 blanket revert 已过时）。models.json 仍可显式覆盖 input。imageSupported 仅作信息字段保留。
    input: Array.isArray(s?.input) ? s.input : (image ? ['text', 'image'] : ['text']),
    imageSupported: image,
    // 图像请求预算：models.json 显式声明优先（供 resolveRequestImagePolicy 使用），
    // 未声明则留空走官方默认值（640000 px / 1 MiB）
    ...(s && 'imagePixelBudget' in s ? { imagePixelBudget: s.imagePixelBudget } : {}),
    ...(s && 'imageMaxBytes' in s ? { imageMaxBytes: s.imageMaxBytes } : {}),
    // 输出预算：models.json 可显式声明 maxTokens 覆盖兜底值（低上限模型用）
    ...(s && Number(s.maxTokens) > 0 ? { maxTokens: Number(s.maxTokens) } : {}),
    toolcall: spec?.tool_call ?? true,
    structuredOutput: !!spec?.structured_output,
    ...(s && 'dataRisk' in s ? { dataRisk: s.dataRisk } : {}),
  }
}

/** 拉取并刷新实时目录；带 TTL、in-flight 去重、失败兜底 */
async function ensureLiveModels(ctx) {
  const now = Date.now()
  if (_liveModels && now - _liveFetchAt < LIVE_TTL_MS) return _liveModels
  if (_liveFetching) return _liveFetching
  _liveFetching = (async () => {
    // 1) 可用性：zen 当前在服务的 free 模型。
    //    zen 的 /models 只给 id，没有 cost/规格，无法在此判定"无 free 后缀但免费"
    //    的模型，因此这里先收全部 id，稍后与 models.dev 规格合并时再按
    //    isFreeModelId（显式名单 + 后缀 + 零成本）筛。
    let liveIds = null
    try {
      const res = await fetch(`${OPENCODE_BASE}/models`, { headers: zenHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      liveIds = (data?.data || [])
        .map((m) => m?.id)
        .filter((id) => typeof id === 'string' && id.length > 0)
      if (!liveIds.length) liveIds = null
    } catch (e) {
      log(ctx, 'warn', `zen /models fetch failed (${e.message}); will fall back to models.dev catalog for availability`)
    }
    // 2) 规格：models.dev 全量注册表（先命中磁盘缓存，避免慢拉取阻塞）
    let specMap = loadSpecCache()
    if (!specMap) {
      try {
        const res = await fetch(MODELS_DEV_URL, { headers: { 'User-Agent': OPENCODE_UA, Accept: 'application/json' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const reg = await res.json()
        const models = reg?.opencode?.models || {}
        const map = {}
        for (const [mid, m] of Object.entries(models)) {
          const id = m?.id || mid
          if (m && typeof m === 'object' && isFreeModelId(id, m)) map[id] = m
        }
        if (Object.keys(map).length) { specMap = map; saveSpecCache(specMap) }
      } catch (e) {
        log(ctx, 'warn', `models.dev fetch failed (${e.message}); specs will be sparse`)
      }
    } else {
      log(ctx, 'info', 'models.dev specs loaded from disk cache')
    }
    // 3) 候选 id：优先 zen 可用性，否则退化为 models.dev 目录。
    //    有规格时以规格为准筛免费成员（覆盖无 free 后缀的模型）；
    //    zen 有 id 但规格缺失时，退回后缀启发式，避免把未知 id 全收进来。
    let candidateIds = liveIds
    if (candidateIds && specMap) {
      const filtered = candidateIds.filter((id) => (specMap[id] ? isFreeModelId(id, specMap[id]) : /free/i.test(id)))
      if (filtered.length) candidateIds = filtered
    } else if (candidateIds) {
      candidateIds = candidateIds.filter((id) => /free/i.test(id))
    }
    if (!candidateIds && specMap) candidateIds = Object.keys(specMap).filter((id) => isFreeModelId(id, specMap[id]))
    if (!candidateIds || !candidateIds.length) {
      if (_liveModels) { log(ctx, 'warn', 'both sources empty; keeping previous live'); return _liveModels }
      throw new Error('no free models from any source')
    }
    const staticMap = new Map(loadModels().map((m) => [m.id, m]))
    _liveModels = candidateIds.map((id) => normalizeEntry(id, specMap ? specMap[id] || null : null, staticMap.get(id)))
    _liveFetchAt = Date.now()
    const specNote = specMap ? ' (specs from models.dev)' : ' (specs sparse)'
    log(ctx, 'info', `live catalog refreshed: ${_liveModels.length} free models${specNote} -> ${_liveModels.map((m) => m.id).join(', ')}`)
    return _liveModels
  })().catch((e) => {
    log(ctx, 'warn', `live catalog refresh failed (${e.message}); ${_liveModels ? 'keeping previous live' : 'falling back to static models.json'}`)
    return _liveModels || loadModels()
  }).finally(() => { _liveFetching = null })
  return _liveFetching
}

/** 当前生效的模型目录：实时优先，静态兜底 */
function currentModels() {
  return _liveModels && _liveModels.length ? _liveModels : loadModels()
}

const REASONING_LEVELS = [
  { id: 'off', name: 'Off', description: '不思考，最快' },
  { id: 'low', name: 'Low', description: '轻量思考' },
  { id: 'high', name: 'High', description: '深度思考' },
  { id: 'max', name: 'Max', description: '极限思考，最耗额度（默认）' },
]

const DEFAULT_REASONING = 'max'

/**
 * dsh 推理等级(off/low/high/max) → 上游 reasoning_effort 词汇的翻译表。
 * 上游(OpenCode Zen)只认 no_think/low/high/max；off 若不显式发
 * no_think 会被上游按默认档计费思考。各模型如接受不同词汇集，
 * 可在 models.json 条目里加 "reasoningEfforts": [...] 覆盖。
 * 实测：max 上游接受（200），难题下产出思考多于 high，故原样下发不降级
 * （注意 reasoning_effort=no_think 当前上游返回 400，off 档依赖上游默认）。
 */
const REASONING_WIRE_MAP = { off: 'no_think', low: 'low', high: 'high', max: 'max' }
const DEFAULT_REASONING_EFFORTS = ['low', 'high', 'max']

/**
 * 把 dsh 等级翻译成该模型接受的 reasoning_effort；不可表达时返回 undefined(不发该字段)。
 * 解析顺序：原词直配（models.json 里声明了的值，如 oxa 的 max）→ 别名表 → 收敛到可用档。
 * reasoningEfforts 为 null/false = 该模型不吃显式控制，永不发送。
 */
function pickReasoningEffort(level, model) {
  if (!level) return undefined
  const raw = model?.reasoningEfforts
  if (raw === null || raw === false) return undefined
  const allowed = Array.isArray(raw) && raw.length > 0 ? raw : DEFAULT_REASONING_EFFORTS
  if (allowed.includes(level)) return level
  const wire = REASONING_WIRE_MAP[level] || level
  if (allowed.includes(wire)) return wire
  if (level === 'off') return undefined
  return allowed.includes('high') ? 'high' : allowed.includes('low') ? 'low' : allowed[0]
}
/** 兜底输出预算：对齐官方 dsh-llm-deepseek 的 DEFAULT_MAX_TOKENS（256e3）。
 *  注意 zen 免费档模型 context 多为 200000，256000 已实测被上游接受（HTTP 200），
 *  但模型条目可用 models.json 的 maxTokens 覆盖（见 normalizeEntry）。 */
const DEFAULT_MAX_TOKENS = 256000
const DEFAULT_CONTEXT_WINDOW = 200000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30000
/** 风暴期深重试：次数给足（快速 503 下几乎不可能全中），但总耗时受预算封顶——
 * 否则挂起型故障（每次尝试吃满连接超时）会把主对话冻住几分钟 */
const MAX_REQUEST_ATTEMPTS = 20
const RETRY_BUDGET_MS = 90000
const CONNECT_TIMEOUT_MS = 45000

/**
 * 免费档已知缺陷：长生成会在思考阶段被网关单方面掐断——流无声结束，
 * 没有 [DONE]、没有 finish_reason、没有答案。策略：
 * - 空流中断（未产出任何块）→ 整单重试（EMPTY_STREAM_RETRIES 次）
 * - 半截中断（思考/正文已流出）→ 自动向后续跑（MAX_CONTINUATIONS 次）：
 *   把已生成的部分连同"继续"指令回传，模型接着写；UI 上同一个思考块无缝续流。
 *   重试间隔递增（TRUNC_BACKOFF_BASE_MS 起、封顶 TRUNC_BACKOFF_CAP_MS、±35%
 *   抖动），绝不立即重试——掐流常伴随上游负载/风控状态，马上重打大概率再被掐。
 * - 工具调用参数流到一半被掐：无法安全续跑，保持优雅收尾（下一轮序列化有 JSON 修复兜底）。
 */
const MAX_CONTINUATIONS = 3
const EMPTY_STREAM_RETRIES = 3
const CONTINUE_NUDGE = '继续：从刚才中断的地方接着输出，不要重复已经输出的内容。'
const TRUNC_BACKOFF_BASE_MS = 2000
const TRUNC_BACKOFF_CAP_MS = 30000

/** 图片输入预算与超限处置：与官方 dsh-llm-deepseek 对齐（见「图像预算」一节）。
 *  这些常量抄自 @deepseek-ai/dsh-llm-deepseek 的默认值，改动务必同步核对上游。 */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 64e4
const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_INLINE_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 64 * 1024 * 1024
const DEFAULT_INLINE_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024
const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20
const DEFAULT_MAX_IMAGES_PER_REQUEST = 600

/**
 * 单模型请求图像预算：与官方 `resolveRequestImagePolicy` 同语义。
 * 该函数是官方 DeepSeek adapter 的私有实现（未从 @deepseek-ai/dsh-llm 导出），
 * 故按上游源码 1:1 复刻；`imagePixelBudget: "low"` 走低清档位。
 */
function resolveRequestImagePolicy(model) {
  return {
    maxPixels: model?.imagePixelBudget === 'low' ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET
      : model?.imagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    maxBytes: model?.imageMaxBytes === undefined ? DEFAULT_REQUEST_IMAGE_MAX_BYTES : model.imageMaxBytes,
  }
}

/** 核心 `@deepseek-ai/dsh-llm` 懒加载：插件是 link 安装，自身 node_modules 里没有核心包，
 *  故按 dsh 安装位置解析（与 sharp 定位同一手法）。加载失败返回 null。 */
let _coreLlm
let _coreLlmTried = false
function coreLlm() {
  if (_coreLlmTried) return _coreLlm
  _coreLlmTried = true
  const dshRoot = join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  try {
    const req = createRequire(join(dshRoot, 'package.json'))
    _coreLlm = req('@deepseek-ai/dsh-llm')
  } catch {
    try {
      _coreLlm = require(join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))
    } catch { _coreLlm = null }
  }
  return _coreLlm
}

/**
 * 视觉旁路"子代理"通道：主请求永不携带像素，图片在序列化阶段被拦下，
 * 由独立的一次性描述请求换取文字描述注入历史。参数取向：
 * 描述要快、便宜、可丢弃——低思考档 + 小 max_tokens + 短超时；
 * 失败就原样重派全新请求（新连接新上下文），绝不复用坏状态。
 */
const DESCRIBE_PROMPT = [
  'You are the vision channel of a coding agent. Describe this image for a reader who cannot see it.',
  '1) kind (UI screenshot / photo / diagram / chart / code photo);',
  '2) ALL visible text VERBATIM (OCR, keep line structure);',
  '3) layout: notable elements and where they are;',
  '4) colors/style only when meaningful; 5) anything anomalous (errors, warnings, red text).',
  'Dense factual prose. No speculation, no filler. Max ~180 words.',
].join(' ')
const DESCRIBE_MAX_TOKENS = 900
const DESCRIBE_ATTEMPTS = 3
const DESCRIBE_TIMEOUT_MS = 20000
/**
 * 内联等待硬预算：主请求最多为一张图的描述等这么久，到点立即降级占位符放行，
 * 同时转交后台补描——上游挂起（无字节超时）时这是主会话不被拖死的保险丝。
 * 环境变量 DSH_ZEN_DESCRIBE_INLINE_BUDGET_MS 可调。
 */
const DESCRIBE_INLINE_BUDGET_MS = Math.max(1000, Number(process.env.DSH_ZEN_DESCRIBE_INLINE_BUDGET_MS) || 25000)
/** 后台补描轮数：每轮都是全新请求，跨约几分钟的窗口持续重派直到成功或放弃 */
const DESCRIBE_BACKGROUND_ROUNDS = 8

/**
 * 切条自动升级（源自 vision-channel-limit-findings.md 实战经验）：
 * 整图描述失败后，适配器自动把图按 ≤STRIP_HEIGHT_PX 高度纯裁剪切条、
 * 逐条描述再拼接——把人工摸索的补救经验内化为机器行为，agent 零配合。
 */
const STRIP_HEIGHT_PX = 300
const STRIP_MAX_COUNT = 8
const STRIP_DESC_ATTEMPTS = 2
const STRIP_INLINE_BUDGET_MS = Math.max(2000, Number(process.env.DSH_ZEN_STRIP_BUDGET_MS) || 40000)

/** 描述缓存上限（按 LRU 粗略淘汰）；键 = 图片字节 sha1 + 尺寸 */
const VISION_CACHE_CAP = 200
const VISION_DESC_CACHE = new Map()

/**
 * 识图通道实测结论（vision-channel-limit-findings.md，2026-08-25）：
 * - 通道对大图统一降采样到 ≈640k 像素后重编码（本插件 maxPixels=640000 与
 *   观察口径一致：1037×616 / 1066×600 / 1481×432 均落在 639–640k px）
 * - 重编码载荷 ≈ 画面信息密度 × 面积：满屏小字等高熵内容会超载，
 *   遭到**确定性拒绝**——同图重试恒定同果，重试纯属浪费预算
 * - 已验证解法：按 ≤300px 高度纯裁剪切条（sharp extract 零重采样），
 *   密集区条带反而能拿到 1:1 免缩放直传，比被降采样的整图更清晰
 * 据此引入"失败记忆冷却"：同图连续失败达阈值后进入冷却期，期间秒级
 * 快速失败（零网络请求）；冷却过期自动恢复探测，兼顾上游能力变化。
 */
const VISION_FAIL_MAX_BEFORE_COOLDOWN = 2
const VISION_FAIL_COOLDOWN_MS = 10 * 60 * 1000
// 冷却满 60 秒后放行一次真实探测：上游若已恢复即可成功，避免"冷却期永远失败"
const VISION_FAIL_PROBE_AFTER_MS = Math.max(1000, Number(process.env.DSH_ZEN_VISION_PROBE_AFTER_MS) || 60 * 1000)
const VISION_FAIL_MEMORY = new Map()

/** 模型输入模态：models.json 条目 "input": ["text","image"] 开启图片，缺省纯文本 */
function inputModalitiesOf(m) {
  return Array.isArray(m?.input) && m.input.includes('image') ? ['text', 'image'] : ['text']
}

function log(ctx, level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] [dsh-opencode-zen] ${msg}`
  // 直接落盘：宿主 logger 路由不可见（曾把全部自愈事件吞进黑洞），文件追加谁也吞不掉
  try { appendFileSync('/tmp/dsh-opencode-zen.log', line + '\n') } catch { /* noop */ }
  try {
    const fn = ctx?.logger?.[level]
    if (typeof fn === 'function') { fn(line); return }
    const c = typeof console?.[level] === 'function' ? console[level] : console.log
    c(line)
  } catch { /* noop */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** 可被调用方取消的等待：signal 一旦中止立刻抛 ABORTED，不傻等剩余间隔 */
function sleepOrAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(aborted()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 读取 key pool 里的 opencode 配置，解析出可用 key 列表；
 * 找不到则回退到 env OPENCODE_ZEN_API_KEY / OPENCODE_GO_API_KEY，最后是 "public"
 */
let _poolKeys = null
let _poolIdx = 0
function loadPoolKeys() {
  if (_poolKeys) return _poolKeys
  const sources = []
  try {
    if (existsSync(POOL_FILE)) {
      const raw = JSON.parse(readFileSync(POOL_FILE, 'utf8'))
      const oc = raw?.pools?.opencode || raw?.pools?.['opencode-zen']
      if (oc && Array.isArray(oc.keys)) sources.push(...oc.keys.filter((k) => k && k !== 'public'))
    }
  } catch { /* ignore */ }
  const env = process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_GO_API_KEY
  if (env) sources.push(env)
  const dedup = [...new Set(sources)]
  _poolKeys = dedup.length > 0 ? dedup : ['public']
  return _poolKeys
}

/** 轮换取一个 key */
function resolveApiKey() {
  const keys = loadPoolKeys()
  const key = keys[_poolIdx % keys.length]
  _poolIdx = (_poolIdx + 1) % keys.length
  return key
}

/**
 * 把内容块（含 tool-result 内层）解析成文本 part 序列。
 * v0.4 视觉旁路：图片不再以 image_url 进主请求——经 loadImage 取到字节后
 * 交给 visionDescribe（隔离"子代理"，失败自动重派）换取文字描述内联；
 * 彻底失败则留占位符。像素只存在于旁路请求里，主对话历史零污染。
 * read_image 等工具产出的图嵌在 tool-result 第二层——这里必须递归。
 */
async function multimodalParts(blocks, loadImage, visCtx) {
  const parts = []
  let text = ''
  const flushText = () => { const t = text.trim(); if (t) { parts.push({ type: 'text', text: t }) } text = '' }
  async function walk(bs) {
    for (const b of bs || []) {
      if (b.type === 'text') text += b.text
      else if (b.type === 'image') {
        flushText()
        try {
          const v = await loadImage(b.attachment)
          if (!v?.data) { parts.push({ type: 'text', text: '[image unavailable]' }); continue }
          let description = null
          let degradeReason = 'vision channel failed'
          try {
            // 内联等待受硬预算约束：预算内拿不到（含上游挂起/缓存中尚未就绪的
            // 后台补描）立即放弃，主请求绝不为视觉通道多等一毫秒
            description = await Promise.race([
              visionDescribe(visCtx?.ctx, visCtx?.modelId, v, visCtx?.signal, { sessionId: visCtx?.sessionId }),
              sleepOrAbort(DESCRIBE_INLINE_BUDGET_MS, visCtx?.signal).then(() => {
                throw Object.assign(new Error('inline budget exceeded'), { code: 'TIMEOUT' })
              }),
            ])
          } catch (err) {
            degradeReason = err?.code === 'VISION_COOLDOWN'
              ? 'channel cooldown — image likely too dense/large for the vision channel'
              : 'vision channel failed'
            log(visCtx?.ctx, 'warn', `vision describe unavailable inline (${err?.code || err?.message || 'unknown'}); degrading to placeholder${err?.code === 'VISION_COOLDOWN' ? '' : ', background respawn queued'}`)
            if (err?.code !== 'VISION_COOLDOWN') {
              visionDescribeBackground(visCtx?.ctx, visCtx?.modelId, v, visCtx?.sessionId)
            }
          }
          parts.push({
            type: 'text',
            text: description
              ? `[image ${v.width}x${v.height}px]\n${description}`
              : `[image ${v.width}x${v.height}px unavailable: ${degradeReason}` +
                `${description === null && degradeReason.startsWith('channel cooldown') ? '; remedy: split the source image into ≤300px-tall strips (pure crop, e.g. sharp.extract) and read each strip separately' : ''}]`,
          })
        } catch (err) {
          parts.push({ type: 'text', text: `[image unavailable: ${err?.message || 'load failed'}]` })
        }
      }
      else if (b.type === 'tool-result') await walk(b.content)
      // 其余块类型忽略
    }
  }
  await walk(blocks)
  flushText()
  return parts
}

/** 递归判断内容块里是否带图片（对齐 dsh-llm 的 contentHasImage 语义） */
function hasImageDeep(blocks) {
  return Array.isArray(blocks) && blocks.some((b) => b.type === 'image' || (b.type === 'tool-result' && hasImageDeep(b.content)))
}

function describeCacheKey(v) {
  return `${createHash('sha1').update(v.data).digest('hex')}.${v.width || '?'}x${v.height || '?'}`
}

/** 写入缓存并自管生命周期：失败即自删（下次重派），超量按插入序淘汰最旧 */
function cacheVisionPromise(key, promise) {
  const tagged = promise.catch((err) => { VISION_DESC_CACHE.delete(key); throw err })
  VISION_DESC_CACHE.set(key, tagged)
  while (VISION_DESC_CACHE.size > VISION_CACHE_CAP) {
    const oldest = VISION_DESC_CACHE.keys().next().value
    if (oldest === undefined || oldest === key) break
    VISION_DESC_CACHE.delete(oldest)
  }
  return tagged
}

/** sharp 加载器：测试注入钩子 → 常规解析 → 宿主 dsh 的 node_modules 兜底 */
let _sharpMod
function loadSharp() {
  if (_sharpMod !== undefined) return _sharpMod
  if (globalThis.__DSH_ZEN_SHARP_TEST__) { _sharpMod = globalThis.__DSH_ZEN_SHARP_TEST__; return _sharpMod }
  try { _sharpMod = require('sharp'); return _sharpMod } catch { /* fallthrough */ }
  try {
    _sharpMod = require(join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'sharp'))
  } catch { _sharpMod = null }
  return _sharpMod
}

/**
 * 视觉旁路请求构造：按该模型的 wire 协议产出正确的端点与请求体。
 * 旧实现把 `image_url` + `/chat/completions` 写死，遇到只认 Anthropic 协议
 * 的模型（union-alpha）必然 500 —— 而这类模型**本身是能原生识图的**，
 * 只因旁路请求格式不对才导致整条识图链失败。
 */
function describeRequest(modelId, image, prompt) {
  const b64 = Buffer.from(image.data).toString('base64')
  const mediaType = image.mediaType || 'image/png'
  if (ANTHROPIC_PROTOCOL_MODELS.has(modelId)) {
    return {
      protocol: 'anthropic',
      endpoint: `${OPENCODE_BASE}/messages`,
      body: {
        model: modelId,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: prompt },
          ],
        }],
        max_tokens: DESCRIBE_MAX_TOKENS,
      },
    }
  }
  return {
    protocol: 'openai',
    endpoint: `${OPENCODE_BASE}/chat/completions`,
    body: {
      model: modelId,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
        ],
      }],
      max_tokens: DESCRIBE_MAX_TOKENS,
      reasoning_effort: 'low',
    },
  }
}

/** 从描述响应里取文本（兼容 OpenAI 与 Anthropic 两种响应形态） */
function extractDescribeText(json) {
  if (!json || typeof json !== 'object') return ''
  const oc = json?.choices?.[0]?.message?.content
  if (typeof oc === 'string') return oc.trim()
  if (Array.isArray(json?.content)) {
    return json.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('').trim()
  }
  return ''
}

/** 单次裸描述请求（切条升级专用：绕过整图缓存/冷却语义，自带超时与错误码） */
async function rawDescribeOnce(modelId, v, prompt, signal, sessionId) {
  const controller = new AbortController()
  const state = { selfAbort: '' }
  const timer = setTimeout(() => { state.selfAbort = 'timeout'; controller.abort() }, DESCRIBE_TIMEOUT_MS)
  try {
    const req = describeRequest(modelId, v, prompt)
    const response = await fetch(req.endpoint, {
      method: 'POST',
      headers: zenHeaders(sessionId),
      body: JSON.stringify(req.body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      throw Object.assign(new Error(`describe HTTP ${response.status}: ${raw.slice(0, 120)}`), { code: response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR' })
    }
    const json = await response.json().catch(() => null)
    const text = extractDescribeText(json)
    if (!text) throw Object.assign(new Error('empty content'), { code: 'TRANSPORT' })
    return text
  } catch (err) {
    if ((err.name === 'AbortError' || err.name === 'TimeoutError') && state.selfAbort) {
      throw Object.assign(new Error('describe timeout'), { code: 'TIMEOUT' })
    }
    throw err
  } finally { clearTimeout(timer) }
}

/** 纯裁剪切条：零重采样逐段 PNG；环境无 sharp 时抛 NO_SHARP */
async function buildStrips(v) {
  const sharp = loadSharp()
  if (!sharp) throw Object.assign(new Error('sharp module unavailable'), { code: 'NO_SHARP' })
  const meta = await sharp(Buffer.from(v.data)).metadata()
  if (!meta.width || !meta.height) throw Object.assign(new Error('unreadable dimensions'), { code: 'NO_SHARP' })
  const n = Math.min(STRIP_MAX_COUNT, Math.max(1, Math.ceil(meta.height / STRIP_HEIGHT_PX)))
  const hh = Math.ceil(meta.height / n)
  const strips = []
  for (let i = 0; i < n; i++) {
    const top = i * hh
    const hHere = Math.min(hh, meta.height - top)
    if (hHere <= 0) break
    const buf = await sharp(Buffer.from(v.data)).extract({ left: 0, top, width: meta.width, height: hHere }).png().toBuffer()
    strips.push({ data: new Uint8Array(buf), mediaType: 'image/png', width: meta.width, height: hHere, seq: i + 1, count: n })
  }
  return strips
}

/**
 * 切条升级描述：整图被通道拒绝后自动切 ≤300px 条带逐条识别再拼接。
 * 任一条带彻底失败即整体抛错（调用方降级占位符）——不交付残缺拼接描述，
 * 避免模型拿半份描述误判全局。
 */
async function describeViaStrips(ctx, modelId, v, signal, sessionId) {
  const strips = await buildStrips(v)
  if (strips.length <= 1) throw Object.assign(new Error('nothing to split'), { code: 'NO_SPLIT' })
  const segs = []
  for (const s of strips) {
    let txt = null, lastErr = null
    for (let a = 0; a < STRIP_DESC_ATTEMPTS && !txt; a++) {
      try {
        txt = await rawDescribeOnce(modelId, s, `${DESCRIBE_PROMPT} （注：这是完整图像自上而下的第 ${s.seq}/${s.count} 段条带，仅描述该段可见内容。）`, signal, sessionId)
      } catch (e) {
        lastErr = e
        if (signal?.aborted) throw aborted()
        if (a < STRIP_DESC_ATTEMPTS - 1) await sleepOrAbort(backoffDelay(a, 0), signal).catch(() => {})
      }
    }
    if (!txt) throw Object.assign(lastErr || new Error('strip describe failed'), { code: lastErr?.code || 'TRANSPORT' })
    segs.push(`【第 ${s.seq}/${s.count} 段 · ${s.width}x${s.height}px】\n${txt}`)
  }
  return `【整图超出视觉通道载荷上限，已自动切为 ${strips.length} 条带分别识别；以下按自上而下顺序拼接】\n\n` + segs.join('\n\n')
}

/**
 * 视觉旁路"子代理"：用一次独立、可丢弃的 chat.completions 把图片换成文字描述。
 * - 每次尝试都是全新请求（新连接新上下文），失败即重派，互不污染；
 * - 结果按图片字节 sha1 缓存：首轮成功后每轮复用，不再重复上传像素；
 * - 全部尝试失败则抛错，由调用方降级为占位符——主流程永不被视觉端点拖死。
 * 刻意不走 openStreamOnce/stream 翻译管线：这是非流式单发 JSON，且绝不能递归进自身恢复逻辑。
 */
async function visionDescribe(ctx, modelId, v, signal, opts) {
  const rounds = opts?.rounds || DESCRIBE_ATTEMPTS
  const sessionId = opts?.sessionId
  const key = describeCacheKey(v)
  // force=true（后台补描专用）：无视现存条目——那可能是即将失败的孤儿内联请求，
  // 附着上去只会陪葬；后台必须跑自己的全新重试链
  if (!opts?.force) {
    const cached = VISION_DESC_CACHE.get(key)
    if (cached) return cached
  }
  // 失败记忆冷却：确定性拒绝的图（密度超载）重试恒定失败，冷却头 60 秒内
  // 秒级快速失败（零网络），之后放行一次真实探测——上游若恢复即可成功，
  // 若仍失败则刷新冷却。兼顾预算保护与能力变化的及时感知。
  const failMemo = VISION_FAIL_MEMORY.get(key)
  if (failMemo && failMemo.count >= VISION_FAIL_MAX_BEFORE_COOLDOWN) {
    const sinceFail = Date.now() - failMemo.lastAt
    if (sinceFail < VISION_FAIL_PROBE_AFTER_MS) {
      throw Object.assign(
        new Error(`vision channel cooldown (${failMemo.count} consecutive ${failMemo.lastCode} failures, probe in ${Math.ceil((VISION_FAIL_PROBE_AFTER_MS - sinceFail) / 1000)}s); image likely too dense for the channel — split into ≤300px-tall strips (pure crop) and read each separately`),
        { code: 'VISION_COOLDOWN' },
      )
    }
    VISION_FAIL_MEMORY.delete(key)
  }
  const attempt = (async () => {
    let lastError = null
    for (let i = 0; i < rounds; i++) {
      if (signal?.aborted) throw aborted()
      const controller = new AbortController()
      const state = { selfAbort: '' }
      const timer = setTimeout(() => { state.selfAbort = 'timeout'; controller.abort() }, DESCRIBE_TIMEOUT_MS)
      try {
        const req = describeRequest(modelId, v, DESCRIBE_PROMPT)
        const response = await fetch(req.endpoint, {
          method: 'POST',
          headers: zenHeaders(sessionId),
          body: JSON.stringify(req.body),
          signal: controller.signal,
        })
        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          lastError = new Error(`describe HTTP ${response.status}: ${raw.slice(0, 120)}`)
          lastError.code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
          if (lastError.code === 'PROVIDER_ERROR') break // 4xx 换多少个新请求结果都一样，别烧额度
        } else {
          const json = await response.json().catch(() => null)
          const text = extractDescribeText(json)
          if (text) { VISION_FAIL_MEMORY.delete(key); return text }
          // 免费档已知病：finish_reason 正常但 content 为空（负载卸载）→ 按可重试失败重派
          lastError = new Error('describe returned empty content')
          lastError.code = 'TRANSPORT'
        }
      } catch (err) {
        if (signal?.aborted) throw aborted()
        if ((err.name === 'AbortError' || err.name === 'TimeoutError') && state.selfAbort) {
          lastError = new Error('describe timeout')
          lastError.code = 'TIMEOUT'
        } else {
          lastError = err
        }
      } finally {
        clearTimeout(timer)
      }
      if (i < rounds - 1) await sleepOrAbort(backoffDelay(i, 0), signal)
    }
    const failMemo = VISION_FAIL_MEMORY.get(key) || { count: 0, lastAt: 0, lastCode: '' }
    failMemo.count += 1
    failMemo.lastAt = Date.now()
    failMemo.lastCode = lastError?.code || 'unknown'
    VISION_FAIL_MEMORY.set(key, failMemo)
    throw lastError || new Error('vision describe failed')
  })()
  return cacheVisionPromise(key, attempt)
}

/** 后台补描去重标记：键在链路活跃期内登记（与缓存条目生命周期解耦——
 * 缓存项可能是即将失败的孤儿内联请求，用它判断会误杀补描派发） */
const VISION_BG_ACTIVE = new Set()

/**
 * 后台补描"子代理"：内联预算耗尽后接手，与主请求完全解耦地持续重派
 * 全新描述请求，成功即入缓存——本轮看占位符，下一轮自动看到真描述。
 */
function visionDescribeBackground(ctx, modelId, v, sessionId) {
  const key = describeCacheKey(v)
  if (VISION_BG_ACTIVE.has(key)) return
  VISION_BG_ACTIVE.add(key)
  const attempt = visionDescribe(ctx, modelId, v, undefined, { rounds: DESCRIBE_BACKGROUND_ROUNDS, sessionId })
  // 先接日志分支消化终态、再挂 finally，且单独吞掉缓存派生 Promise 的拒绝——
  // 这条链路没有任何调用方 await，任何一处派生拒绝漏接都会以 unhandledRejection 杀掉宿主进程
  attempt.then(
    () => log(ctx, 'info', 'background vision describe succeeded; cached for upcoming turns'),
    (err) => log(ctx, 'warn', `background vision describe gave up (${err?.code || err?.message || 'unknown'})`),
  ).finally(() => VISION_BG_ACTIVE.delete(key))
  cacheVisionPromise(key, attempt).catch(() => { /* 终态已由上方日志分支记录 */ })
}

/** describe 模式下 part 序列必然纯文本，折叠成单字符串（对网关最稳的 wire 形态） */
function joinTextParts(parts) {
  return parts.map((p) => p.text).join('\n')
}

/**
 * 将 Harness 消息转成 OpenAI chat.completions 请求体。
 * 视觉策略（v0.4）：带图消息经 loadImage + visionDescribe 转为文字描述，
 * wire 层不再出现 image_url——主请求纯文本化，上游视觉端点故障只影响
 * 单张图的描述质量，不可能拖垮或毒化整个会话。
 */
async function serializeMessages(messages, systemPrompt, loadImage, visCtx) {
  const wire = []
  if (systemPrompt) wire.push({ role: 'system', content: systemPrompt })
  for (const m of messages || []) {
    const role = m.role
    if (role === 'system') {
      wire.push({ role: 'system', content: flattenText(m.content) })
      continue
    }
    if (role === 'assistant') {
      const text = flattenText(m.content)
      const reasoning = blocksOf(m.content, 'reasoning').map((b) => b.text).join('')
      // 历史里的 arguments 必须是合法 JSON 串：免费档模型偶尔生成未闭合的
      // 参数串，原样转发会让厂商网关 JSON 解析炸断(错误码 -3007)，且因
      // 常驻历史导致该会话后续每轮全部 400。非法时包一层保内容保上下文。
      const toolCalls = blocksOf(m.content, 'tool-call').map((b) => {
        let args = b.arguments
        if (typeof args === 'string' && args.length > 0) {
          try { JSON.parse(args) } catch { args = JSON.stringify({ _raw: args }) }
        } else {
          args = '{}'
        }
        return { id: b.id, type: 'function', function: { name: b.name, arguments: args } }
      })
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length) msg.tool_calls = toolCalls
      wire.push(msg)
      continue
    }
    const toolResults = blocksOf(m.content, 'tool-result')
    const text = flattenText(m.content)
    // 用户消息：有加载器且带图片块（含嵌套）→ 经视觉旁路转为文字描述。
    // 注意：含 tool-result 的消息不走这里——它们必须在下方转成 role:'tool'，
    // 否则 assistant.tool_calls 会失去配对回包，被严格网关 400。
    if (role === 'user' && loadImage && toolResults.length === 0 && hasImageDeep(m.content)) {
      const parts = await multimodalParts(m.content, loadImage, visCtx)
      if (parts.length > 0) { wire.push({ role: 'user', content: joinTextParts(parts) }); continue }
    }
    if (text || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const r of toolResults) {
      // 工具结果里的图（如 read_image 截图）→ 同样经旁路描述为文字
      if (loadImage && hasImageDeep(r.content)) {
        const parts = await multimodalParts(r.content, loadImage, visCtx)
        wire.push({ role: 'tool', tool_call_id: r.toolCallId, content: parts.length ? joinTextParts(parts) : '(no output)' })
        continue
      }
      wire.push({ role: 'tool', tool_call_id: r.toolCallId, content: flattenText(r.content) || '(no output)' })
    }
  }
  return wire
}

function flattenText(content) {
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  }
  return typeof content === 'string' ? content : ''
}

function blocksOf(content, type) {
  return Array.isArray(content) ? content.filter((b) => b.type === type) : []
}

function serializeTools(tools) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/**
 * Anthropic `/v1/messages` 协议适配（union-alpha 等只认该协议的 zen 模型）。
 * 与 OpenAI 线格式的差异：
 *  - system 是顶层字段，不在 messages 里
 *  - 工具调用是 content 里的 tool_use 块；工具结果是 user 消息里的 tool_result 块
 *  - 工具 schema 字段名是 input_schema（不是 parameters）
 *  - thinking 块回放需要 signature，故历史里**丢弃 reasoning**（回放会 400）
 *  - temperature 取值 0..1（OpenAI 允许到 2），超界会 400，需夹紧
 */
function serializeAnthropicTools(tools) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    input_schema: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
  }))
}

/** 把历史里的 tool-call arguments 规范成合法 JSON 对象（Anthropic 的 input 必须是对象） */
function parseToolInput(args) {
  if (args && typeof args === 'object') return args
  if (typeof args === 'string' && args.length > 0) {
    try { return JSON.parse(args) } catch { return { _raw: args } }
  }
  return {}
}

/** 将 Harness 消息转成 Anthropic /v1/messages 请求体（含系统提示归并、视觉旁路转文字） */
async function serializeAnthropicMessages(messages, systemPrompt, loadImage, visCtx) {
  const out = []
  const systemParts = []
  if (systemPrompt) systemParts.push(systemPrompt)

  for (const m of messages || []) {
    const role = m.role
    if (role === 'system') {
      const t = flattenText(m.content)
      if (t) systemParts.push(t)
      continue
    }

    if (role === 'assistant') {
      const blocks = []
      const text = flattenText(m.content)
      if (text) blocks.push({ type: 'text', text })
      // 注意：reasoning 不回放——Anthropic 的 thinking 块需要 signature，缺失会 400
      for (const b of blocksOf(m.content, 'tool-call')) {
        blocks.push({ type: 'tool_use', id: b.id || `toolu_${randomHex(24)}`, name: b.name || '', input: parseToolInput(b.arguments) })
      }
      // Anthropic 不接受空 content；退化成占位文本保证轮次不丢
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(no content)' }] })
      continue
    }

    // user / 其他：工具结果必须回成 user 消息里的 tool_result 块
    const toolResults = blocksOf(m.content, 'tool-result')
    const text = flattenText(m.content)

    // 纯用户文本（无图无工具结果）→ 最简单的字符串形式
    if (toolResults.length === 0) {
      if (loadImage && hasImageDeep(m.content)) {
        const parts = await multimodalParts(m.content, loadImage, visCtx)
        out.push({ role: 'user', content: parts.length ? joinTextParts(parts) : (text || '(no content)') })
      } else {
        out.push({ role: 'user', content: text || '(no content)' })
      }
      continue
    }

    const blocks = []
    if (text) blocks.push({ type: 'text', text })
    for (const r of toolResults) {
      let content
      if (loadImage && hasImageDeep(r.content)) {
        const parts = await multimodalParts(r.content, loadImage, visCtx)
        content = parts.length ? joinTextParts(parts) : '(no output)'
      } else {
        content = flattenText(r.content) || '(no output)'
      }
      blocks.push({ type: 'tool_result', tool_use_id: r.toolCallId, content })
    }
    out.push({ role: 'user', content: blocks })
  }

  // Anthropic 要求 messages 非空
  if (out.length === 0) out.push({ role: 'user', content: '(no content)' })
  return { system: systemParts.length ? systemParts.join('\n\n') : undefined, messages: out }
}

/**
 * 解析 Anthropic SSE：事件形如
 *   event: content_block_delta
 *   data: {...}
 * 产出 { event, data } 供 AnthropicStreamTranslator 消费；
 * message_stop 视为完成标记（对应 OpenAI 的 [DONE]）。
 */
async function* parseAnthropicSse(response, marks) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (!raw || raw === '[DONE]') {
          if (raw === '[DONE]' && marks) marks.done = true
          continue
        }
        let data
        try { data = JSON.parse(raw) } catch { continue }
        if (data?.type === 'message_stop' && marks) marks.done = true
        if (data?.type === 'error') {
          const msg = data.error?.message || 'upstream error'
          const e = new Error(`OpenCode Zen (anthropic) stream error: ${msg}`)
          e.code = 'PROVIDER_ERROR'
          throw e
        }
        yield data
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** 工具参数残缺时隔离成合法但必然校验失败的 JSON（与 StreamTranslator 同语义） */
function quarantineInvalidArgs(block) {
  if (!block || block.kind !== 'tool-call' || block.argsQuarantined) return
  try { JSON.parse(block.text) } catch {
    block.text = JSON.stringify({ _truncated: true, _raw: block.text })
    block.argsQuarantined = true
  }
}

/**
 * Anthropic 流式事件 → Harness 块事件翻译器。
 * 对外接口与 StreamTranslator 完全一致（feed/pump/finalize/openedBlocks/
 * continuable/toolBlocks/sawFinishReason/snapshotPartial/quarantinePartialTools），
 * 因此 stream() 的断流续跑恢复机制可原样复用。
 */
class AnthropicStreamTranslator {
  constructor(estimateInput) {
    this.estimateInput = estimateInput
    this.nextIndex = 0
    this.textBlock = null
    this.reasoningBlock = null
    this.toolBlocks = new Map()   // anthropic content index -> block
    this.order = []
    this.finish = null
    this.usage = null
    this.sawFinishReason = false
  }

  get openedBlocks() { return this.order.length > 0 }
  get continuable() { return this.toolBlocks.size === 0 && Boolean(this.reasoningBlock || this.textBlock) }

  #open(kind) {
    const block = { index: this.nextIndex++, kind, text: '' }
    this.order.push(block)
    return block
  }

  quarantinePartialTools() {
    for (const b of this.order) quarantineInvalidArgs(b)
    this.toolBlocks.clear()
  }

  snapshotPartial() {
    return { reasoning: this.reasoningBlock?.text || '', text: this.textBlock?.text || '' }
  }

  /** 吃一个 Anthropic 事件，吐出 Harness 块事件 */
  *feed(ev) {
    switch (ev?.type) {
      case 'message_start': {
        const u = ev.message?.usage
        if (u) this.usage = this.#mapUsage(u)
        break
      }
      case 'content_block_start': {
        const cb = ev.content_block || {}
        if (cb.type === 'text') {
          if (!this.textBlock) {
            this.textBlock = this.#open('text')
            yield { type: 'block-start', index: this.textBlock.index, blockType: 'text' }
          }
        } else if (cb.type === 'thinking' || cb.type === 'redacted_thinking') {
          if (!this.reasoningBlock) {
            this.reasoningBlock = this.#open('reasoning')
            yield { type: 'block-start', index: this.reasoningBlock.index, blockType: 'reasoning' }
          }
        } else if (cb.type === 'tool_use') {
          const block = this.#open('tool-call')
          block.callId = cb.id || randomUUID()
          block.name = cb.name || ''
          this.toolBlocks.set(ev.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          // 首片可能直接带完整 input（非流式为对象，流式为 {}）
          if (cb.input && typeof cb.input === 'object' && Object.keys(cb.input).length > 0) {
            const args = JSON.stringify(cb.input)
            block.text += args
            yield { type: 'tool-call-delta', index: block.index, id: block.callId, name: block.name, argumentsDelta: args }
          }
        }
        break
      }
      case 'content_block_delta': {
        const d = ev.delta || {}
        if (d.type === 'text_delta' && typeof d.text === 'string' && d.text.length > 0) {
          if (!this.textBlock) {
            this.textBlock = this.#open('text')
            yield { type: 'block-start', index: this.textBlock.index, blockType: 'text' }
          }
          this.textBlock.text += d.text
          yield { type: 'text-delta', index: this.textBlock.index, text: d.text }
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking.length > 0) {
          if (!this.reasoningBlock) {
            this.reasoningBlock = this.#open('reasoning')
            yield { type: 'block-start', index: this.reasoningBlock.index, blockType: 'reasoning' }
          }
          this.reasoningBlock.text += d.thinking
          yield { type: 'reasoning-delta', index: this.reasoningBlock.index, text: d.thinking }
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string' && d.partial_json.length > 0) {
          let block = this.toolBlocks.get(ev.index)
          if (!block) {
            // 极端情况下没收到 content_block_start：补建，保证参数不丢
            block = this.#open('tool-call')
            block.callId = randomUUID()
            this.toolBlocks.set(ev.index, block)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          block.text += d.partial_json
          const deltaEvent = { type: 'tool-call-delta', index: block.index, id: block.callId, argumentsDelta: d.partial_json }
          if (block.name) deltaEvent.name = block.name
          yield deltaEvent
        }
        // signature_delta 无需处理（不回放 thinking，不持有 signature）
        break
      }
      case 'message_delta': {
        // stop_reason 非空 = 上游明确表达"我说完了"（含 tool_use / end_turn / max_tokens）
        if (ev.delta?.stop_reason) {
          this.sawFinishReason = true
          if (ev.delta.stop_reason === 'max_tokens') this.finish = { kind: 'max-tokens' }
        }
        if (ev.usage) this.usage = { ...(this.usage || {}), ...this.#mapUsage(ev.usage, this.usage) }
        break
      }
      case 'message_stop':
        this.sawFinishReason = true
        break
      default: break
    }
  }

  #mapUsage(u, prev) {
    const cacheRead = Number(u.cache_read_input_tokens) || 0
    const input = u.input_tokens !== undefined ? Number(u.input_tokens) || 0 : (prev?.inputTokens || 0)
    const output = u.output_tokens !== undefined ? Number(u.output_tokens) || 0 : (prev?.outputTokens || 0)
    return {
      inputTokens: Math.max(0, input - cacheRead),
      outputTokens: output,
      ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    }
  }

  async *pump(rawChunks, marks) {
    for await (const chunk of rawChunks) yield* this.feed(chunk)
    return (marks.done || this.sawFinishReason) ? 'clean' : 'aborted'
  }

  *finalize() {
    for (const block of this.order) {
      switch (block.kind) {
        case 'text': yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; break
        case 'reasoning': yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }; break
        case 'tool-call':
          quarantineInvalidArgs(block)
          yield {
            type: 'block-end',
            index: block.index,
            block: { type: 'tool-call', id: block.callId || '', name: block.name || '', arguments: block.text || '{}' },
          }
          break
      }
    }
    let usage = this.usage
    if (!usage && this.estimateInput) {
      const outChars = (this.textBlock?.text || '').length + (this.reasoningBlock?.text || '').length
      usage = { inputTokens: Math.ceil(this.estimateInput().length / 4), outputTokens: Math.ceil(outChars / 4) }
    }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: this.finish || { kind: 'stop' } }
  }
}

/**
 * 非流式应答 → 块事件。用于 Anthropic 线的"流式空体"兜底：
 * union-alpha 的长生成经常以 HTTP 200 + **完全空的 body** 收场（约 32s 后），
 * 而同样的请求改成 `stream:false` 却能稳定拿到完整结果。故该线在空流后
 * 不再只靠重试，而是退回非流式取回答案，避免整轮失败。
 * 产出与 AnthropicStreamTranslator 相同的块/usage/finish 事件。
 */
function anthropicMessageToEvents(json, estimateInput) {
  const events = []
  let idx = 0
  const blocks = []
  for (const c of json?.content || []) {
    if (!c) continue
    if (c.type === 'text' && typeof c.text === 'string' && c.text.length > 0) {
      blocks.push({ kind: 'text', index: idx, text: c.text })
      idx++
    } else if ((c.type === 'thinking' || c.type === 'redacted_thinking') && typeof c.thinking === 'string' && c.thinking.length > 0) {
      blocks.push({ kind: 'reasoning', index: idx, text: c.thinking })
      idx++
    } else if (c.type === 'tool_use') {
      blocks.push({ kind: 'tool-call', index: idx, callId: c.id || randomUUID(), name: c.name || '', text: JSON.stringify(c.input ?? {}) })
      idx++
    }
  }
  for (const b of blocks) {
    events.push({ type: 'block-start', index: b.index, blockType: b.kind })
    if (b.kind === 'text') events.push({ type: 'text-delta', index: b.index, text: b.text })
    else if (b.kind === 'reasoning') events.push({ type: 'reasoning-delta', index: b.index, text: b.text })
    else events.push({ type: 'tool-call-delta', index: b.index, id: b.callId, name: b.name, argumentsDelta: b.text })
    if (b.kind === 'tool-call') {
      events.push({ type: 'block-end', index: b.index, block: { type: 'tool-call', id: b.callId, name: b.name, arguments: b.text || '{}' } })
    } else {
      events.push({ type: 'block-end', index: b.index, block: { type: b.kind === 'reasoning' ? 'reasoning' : 'text', text: b.text } })
    }
  }
  const u = json?.usage
  let usage = null
  if (u) {
    const cacheRead = Number(u.cache_read_input_tokens) || 0
    const input = Number(u.input_tokens) || 0
    usage = { inputTokens: Math.max(0, input - cacheRead), outputTokens: Number(u.output_tokens) || 0, ...(cacheRead ? { cacheReadTokens: cacheRead } : {}) }
  } else if (estimateInput) {
    const outChars = blocks.filter((b) => b.kind !== 'tool-call').reduce((n, b) => n + b.text.length, 0)
    usage = { inputTokens: Math.ceil(estimateInput().length / 4), outputTokens: Math.ceil(outChars / 4) }
  }
  events.push({ type: 'usage', usage })
  events.push({ type: 'finish', reason: json?.stop_reason === 'max_tokens' ? { kind: 'max-tokens' } : { kind: 'stop' } })
  return events
}

/** Anthropic 续跑请求：把已产出的正文作为 assistant 回合 + "继续"指令。
 *  只回放正文——thinking 块缺 signature，回放会被上游拒绝。 */
function buildAnthropicContinuationBody(baseBody, partial) {
  if (!partial?.text) return null
  return {
    ...baseBody,
    messages: [
      ...baseBody.messages,
      { role: 'assistant', content: [{ type: 'text', text: partial.text }] },
      { role: 'user', content: [{ type: 'text', text: CONTINUE_NUDGE }] },
    ],
  }
}

/** SSE 解析：一行行拿 data，拼出 OpenAI 流式 chunks */
async function* parseSse(response, marks) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') { if (marks) marks.done = true; return }
        try { yield JSON.parse(data) } catch { /* 忽略坏行 */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 流空闲看门狗：包一层 body reader，每收到字节就重置计时器；
 * 连续 DEFAULT_STREAM_IDLE_TIMEOUT_MS 无任何数据才中止连接。
 * 慢速长流不再被"总时长上限"腰斩，卡死流也能自动回收并走重试。
 */
function attachIdleWatch(response, controller, signal, onIdleFire) {
  if (!response.body || !(DEFAULT_STREAM_IDLE_TIMEOUT_MS > 0)) return response
  const raw = response.body.getReader()
  let timer = setTimeout(onIdle, DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  function onIdle() { onIdleFire?.(); try { controller.abort() } catch { /* already aborted */ } }
  function reset() { clearTimeout(timer); if (!controller.signal.aborted) timer = setTimeout(onIdle, DEFAULT_STREAM_IDLE_TIMEOUT_MS) }
  const stop = () => clearTimeout(timer)
  controller.signal.addEventListener('abort', stop, { once: true })
  signal?.addEventListener('abort', stop, { once: true })
  return Object.create(response, {
    body: { value: { getReader() {
      return {
        read: async () => {
          let r
          try { r = await raw.read() } finally { reset() }
          return r
        },
        releaseLock: () => { stop(); try { raw.releaseLock() } catch { /* already released */ } },
      }
    }, enumerable: true } },
  })
}

/** 瞬时故障退避：指数增长(800ms 起、封顶 5s)+±20% 抖动；上游给了 Retry-After 则优先遵从 */
function backoffDelay(attempt, retryAfterMs) {
  if (retryAfterMs > 0) return Math.min(retryAfterMs, 15000)
  return Math.round(Math.min(800 * 2 ** attempt, 5000) * (0.9 + Math.random() * 0.2))
}

/**
 * 断流恢复间隔：与上面的瞬时故障退避分开调参。掐流往往伴随上游负载/风控
 * 状态，马上重打大概率落在同一个坏状态上再被掐，所以步进要大：
 * 2s → 4s → 8s → 16s → … 封顶 30s；±35% 大抖动打散重试同步。
 * step 由 stream() 里的 cutStep 计数器跨所有断流事件递增——被掐得越多等得越久。
 */
function truncationBackoff(step) {
  const base = Math.min(TRUNC_BACKOFF_BASE_MS * 2 ** step, TRUNC_BACKOFF_CAP_MS)
  return Math.round(base * (0.65 + Math.random() * 0.7))
}

/**
 * 流翻译器：把上游 OpenAI SSE chunk 流翻译成 DSH 块事件。
 * 与旧的一次性函数不同，它是有状态的——可以跨多次上游请求累积同一个
 * 块上下文，这是"断流续跑"能做到 UI 无感衔接的关键：
 * 思考块尚未关闭就发起续跑请求，后续 delta 继续流进同一个 index。
 */
class StreamTranslator {
  constructor(estimateInput) {
    this.estimateInput = estimateInput
    this.nextIndex = 0
    this.textBlock = null
    this.reasoningBlock = null
    this.toolBlocks = new Map()
    this.order = []
    this.finish = null
    this.usage = null
    this.sawFinishReason = false
  }

  get openedBlocks() { return this.order.length > 0 }

  /** 是否处于可安全续跑的阶段：只产出了思考/正文，没有涉及工具调用 */
  get continuable() {
    return this.toolBlocks.size === 0 && Boolean(this.reasoningBlock || this.textBlock)
  }

  /**
   * 把非法（残缺）的工具调用参数隔离成"合法但必然校验失败"的 JSON。
   * 为什么不直接丢弃：块事件已交付宿主，只能收尾；为什么不原样交付：
   * 残缺参数让宿主静默失败（表现为"改文件改一半停了"），且入史后会毒化
   * 网关(-3007)。包装成 _truncated 后宿主执行会得到明确的参数校验错误，
   * 模型下一轮能看到错误并自行重试。幂等。
   */
  #ensureValidArgs(block) {
    if (block.kind !== 'tool-call' || block.argsQuarantined) return
    try { JSON.parse(block.text) } catch {
      block.text = JSON.stringify({ _truncated: true, _raw: block.text })
      block.argsQuarantined = true
    }
  }

  /**
   * 工具阶段断流的恢复前置：隔离所有残缺参数，并清空 toolBlocks 映射——
   * 这样整轮重试产生的新工具调用会以全新块身份进入，而不是把新参数
   * 续写进已隔离的旧块。已完成且合法的调用保持原样。
   */
  quarantinePartialTools() {
    for (const b of this.order) this.#ensureValidArgs(b)
    this.toolBlocks.clear()
  }

  /** 已产出内容快照（用于构造续跑请求的历史） */
  snapshotPartial() {
    return {
      reasoning: this.reasoningBlock?.text || '',
      text: this.textBlock?.text || '',
    }
  }

  #open(kind) {
    const block = { index: this.nextIndex++, kind, text: '' }
    this.order.push(block)
    return block
  }

  /** 吃一个上游 SSE chunk，吐出对应的块事件 */
  *feed(chunk) {
    const choices = chunk.choices || []
    for (const choice of choices) {
      const delta = choice.delta || {}
      const rc = delta.reasoning_content
      if (typeof rc === 'string' && rc.length > 0) {
        if (!this.reasoningBlock) {
          this.reasoningBlock = this.#open('reasoning')
          yield { type: 'block-start', index: this.reasoningBlock.index, blockType: 'reasoning' }
        }
        this.reasoningBlock.text += rc
        yield { type: 'reasoning-delta', index: this.reasoningBlock.index, text: rc }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (!this.textBlock) {
          this.textBlock = this.#open('text')
          yield { type: 'block-start', index: this.textBlock.index, blockType: 'text' }
        }
        this.textBlock.text += content
        yield { type: 'text-delta', index: this.textBlock.index, text: content }
      }
      for (const call of delta.tool_calls || []) {
        const idx = call.index || 0
        let block = this.toolBlocks.get(idx)
        if (!block) {
          block = this.#open('tool-call')
          // 新版核心（dsh-llm >= 0.1.x）要求 tool-call-delta 必须携带 id：
          // 须为字符串且非空，否则抛 "tool-call-delta id must be a string"。
          // 上游首片若未给 id，这里生成稳定 uuid 兜底，保证整条 tool-call 的 id 一致。
          block.callId = call.id || randomUUID()
          this.toolBlocks.set(idx, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        const fn = call.function || {}
        if (call.id) block.callId = call.id
        if (fn.name) block.name = fn.name
        if (fn.arguments) {
          block.text += fn.arguments
          // 必须传 id；name 仅在确有值时携带——空串会被核心当作 noop 丢弃参数。
          const deltaEvent = { type: 'tool-call-delta', index: block.index, id: block.callId, argumentsDelta: fn.arguments }
          if (block.name) deltaEvent.name = block.name
          yield deltaEvent
        }
      }
      // 注意：finish_reason 在 choice 上而不是 chunk 上（修复旧实现取错位置、
      // 导致 max-tokens 截止原因从未被识别的问题）
      if (choice.finish_reason) {
        this.sawFinishReason = true
        if (choice.finish_reason === 'length') this.finish = { kind: 'max-tokens' }
      }
    }
    if (chunk.usage) this.usage = mapUsage(chunk.usage)
  }

  /**
   * 泵完一整条上游流。返回 'clean'（收到 [DONE] 或任一 finish_reason，
   * 即上游明确表达了"我说完了"）或 'aborted'（字节流无声中断/中途异常，
   * 上游没有表达完成意图）。调用方取消由异常路径上抛。
   */
  async *pump(rawChunks, marks) {
    for await (const chunk of rawChunks) yield* this.feed(chunk)
    return (marks.done || this.sawFinishReason) ? 'clean' : 'aborted'
  }

  /** 收尾：补全所有块 + usage 兜底 + finish。只在干净结束或放弃续跑时调用一次。 */
  *finalize() {
    for (const block of this.order) {
      switch (block.kind) {
        case 'text': yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; break
        case 'reasoning': yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }; break
        case 'tool-call':
          this.#ensureValidArgs(block)
          yield {
            type: 'block-end',
            index: block.index,
            block: { type: 'tool-call', id: block.callId || '', name: block.name || '', arguments: block.text },
          }
          break
      }
    }
    let usage = this.usage
    if (!usage && this.estimateInput) {
      const outChars = (this.textBlock?.text || '').length + (this.reasoningBlock?.text || '').length
      usage = {
        inputTokens: Math.ceil(this.estimateInput().length / 4),
        outputTokens: Math.ceil(outChars / 4),
      }
    }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: this.finish || { kind: 'stop' } }
  }
}

/** 构造断流续跑请求：部分输出作为 assistant 历史回传 + "继续"指令（等价于用户手动敲"继续"） */
function buildContinuationBody(baseBody, partial) {
  if (!partial.reasoning && !partial.text) return null
  const assistant = { role: 'assistant', content: partial.text }
  if (partial.reasoning) assistant.reasoning_content = partial.reasoning
  return {
    ...baseBody,
    messages: [...baseBody.messages, assistant, { role: 'user', content: CONTINUE_NUDGE }],
  }
}

function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens || 0
  return {
    inputTokens: (usage.prompt_tokens || 0) - (cacheRead || 0),
    outputTokens: usage.completion_tokens || 0,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
  }
}

/** LlmAdapter 核心实现 */
class OpenCodeZenAdapter {
  constructor(ctx) { this.ctx = ctx }
  providerInfo(provider) { return { id: provider, name: 'OpenCode Zen' } }
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMITED', 'TIMEOUT', 'TRANSPORT'],
      backoff: { initialDelayMs: 800, maxDelayMs: 5000, jitterRatio: 0.1 },
    }
  }
  async listModels() {
    const models = await ensureLiveModels(this.ctx)
    return models.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, description: m.description, inputModalities: inputModalitiesOf(m) }))
  }
  async resolveModel(provider, model) {
    const models = await ensureLiveModels(this.ctx)
    const found = models.find((m) => m.id === model)
    const reasoning = {
      efforts: REASONING_LEVELS,
      defaultEffort: DEFAULT_REASONING,
    }
    return Promise.resolve({
      provider,
      id: model,
      name: found?.name || model,
      ...(found?.description ? { description: found.description } : {}),
      inputModalities: found ? inputModalitiesOf(found) : ['text'],
      context: { contextWindow: found?.contextWindow || DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: Number(found?.maxTokens) || DEFAULT_MAX_TOKENS,
      reasoning,
    })
  }

  /**
   * dsh-llm (>=0.1.1-rc) 的 LlmAdapter 契约要求动态适配器自带 prepareCall
   * （把"解析模型元数据"与"本次代次的 dispatch 入口"绑在一起），
   * 此实现与官方基类默认实现一致。
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * 打开一条上游流式连接。"拿到响应头之前"的失败（HTTP 429/5xx、连接超时）
   * 在这里就地退避重试（backoffDelay 快节奏）；成功返回响应与控制上下文，
   * 流中途的断流由上层 StreamTranslator 恢复策略接管。
   */
  async openStreamOnce(reqBody, options) {
    const signal = options.signal
    const sessionId = options.sessionId
    // 上游线协议由请求体里的 model 决定：union-alpha 等只认 Anthropic /v1/messages
    const protocol = ANTHROPIC_PROTOCOL_MODELS.has(reqBody?.model) ? 'anthropic' : 'openai'
    const endpoint = protocol === 'anthropic' ? `${OPENCODE_BASE}/messages` : `${OPENCODE_BASE}/chat/completions`
    let lastError = null
    let retryAfterMs = 0
    const startedAt = Date.now()
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw aborted()
      // 预算耗尽即收：深重试只为穿越快速失败的风暴，不为挂起型故障陪跑
      if (attempt > 0 && Date.now() - startedAt > RETRY_BUDGET_MS) break
      const controller = new AbortController()
      // selfAbort: 区分"自身超时中止"(connect/idle，按 TIMEOUT 走重试)与"调用方取消"(原样上抛)
      const state = { selfAbort: '' }
      const onAbort = () => controller.abort()
      const connectTimer = setTimeout(() => { state.selfAbort = 'connect'; controller.abort() }, options.timeoutMs || CONNECT_TIMEOUT_MS)
      if (signal) signal.addEventListener('abort', onAbort)
      try {
        let response
        try {
          response = await fetch(endpoint, {
            method: 'POST',
            headers: zenHeaders(sessionId),
            body: JSON.stringify(reqBody),
            signal: controller.signal,
          })
        } finally {
          clearTimeout(connectTimer)
        }

        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          const code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
          // 免费档归属闸门：网关认为请求不是从 opencode 官方客户端发出的。
          // 2026-09-17 起该闸门校验的是 x-opencode-session 必须是 `ses_`+26 位
          // 小写 hex（旧的头名 x-session-id 已不被识别）；被代理剥离/改写头，
          // 或上游再次改头名，都会命中这里。给出可操作提示而非广告语。
          if (/MissingSessionID|free tier can only be used/i.test(raw)) {
            const e = new Error(
              `OpenCode Zen rejected the request at the attribution gate (FreeTierError): the opencode client identity headers did not reach the gateway. ` +
              `This plugin sends "x-opencode-session" (ses_ + 26 lowercase hex) on every zen request; check for a proxy/middleware stripping or rewriting custom headers. Raw: ${raw.slice(0, 200)}`,
            )
            e.code = 'PROVIDER_ERROR'
            e.fatal = true
            throw e
          }
          const err = new Error(`OpenCode Zen HTTP ${response.status}: ${raw.slice(0, 300)}`)
          err.code = code
          if (code === 'PROVIDER_ERROR') { err.fatal = true; throw err }
          const ra = Number(response.headers?.get?.('retry-after'))
          retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0
          lastError = err
        } else {
          // 非流式请求不要包 idle-watch：那层 Object.create(response) 代理会丢掉
          // undici Response 的私有槽位，导致后续 response.json() 抛
          // "Cannot read private member #state"。非流式也没有"流空闲"概念。
          if (!options.nonStreaming) {
            response = attachIdleWatch(response, controller, signal, () => { state.selfAbort = 'idle' })
          }
          return { response, controller, state }
        }
      } catch (err) {
        if (signal?.aborted) throw aborted()
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          if (!state.selfAbort || err.fatal) throw err
          lastError = new Error(`OpenCode Zen ${state.selfAbort} timeout`)
          lastError.code = 'TIMEOUT'
        } else if (err.fatal) {
          throw err
        } else {
          lastError = err
        }
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      if (attempt < MAX_REQUEST_ATTEMPTS - 1) await sleep(backoffDelay(attempt, retryAfterMs))
    }
    throw lastError || new Error('OpenCode Zen request failed')
  }

  /**
   * 非流式兜底取回（Anthropic 线专用）。union-alpha 的长生成经常以
   * HTTP 200 + 完全空 body 收场（约 32s），而同样的请求 `stream:false`
   * 能稳定拿回完整结果，故空流后直接退回非流式，而不是反复重试流式。
   * 复用 openStreamOnce 的连接级重试（把 stream 去掉即可）。
   */
  async fetchOnceNonStreaming(reqBody, options) {
    const { stream: _s, stream_options: _so, ...rest } = reqBody
    const { response } = await this.openStreamOnce(rest, { ...options, nonStreaming: true })
    const json = await response.json().catch(() => null)
    return json
  }

  /**
   * 对外主入口。恢复矩阵：
   * - 上游干净结束（[DONE]/finish_reason）→ 正常收尾
   * - 空流中断（零输出）→ 整单重试 EMPTY_STREAM_RETRIES 次
   * - Anthropic 线空流 → 直接退回非流式取回（该线长生成流式恒空）
   * - 半截中断（思考/正文已流出）→ 递增间隔后自动续跑 MAX_CONTINUATIONS 次
   * - 工具调用参数被掐 → 残参隔离成合法但必失败的 JSON（宿主得到明确
   *   校验错误而非静默失败），然后整轮重打
   * - 恢复预算耗尽 → 优雅收尾已交付的内容（工具参数仍保证合法）
   * 断流等待绝不立即重试：truncationBackoff(cutStep++) 递增 + 大抖动。
   */
  async *stream(options) {
    const { model, messages, system, tools, maxTokens, reasoningEffort, temperature, signal, sessionId } = options

    const models = await ensureLiveModels(this.ctx)
    const found = models.find((m) => m.id === model)
    const effort = pickReasoningEffort(reasoningEffort, found)

    // 图片输入：模型声明支持时，从宿主附件服务解析字节；服务缺失则降级纯文本。
    // 预算与官方 resolveRequestImagePolicy 同语义（模型声明优先，缺省走官方默认值）。
    let loadImage = null
    if (found && inputModalitiesOf(found).includes('image')) {
      const attachments = typeof this.ctx?.get === 'function' ? this.ctx.get('attachments') : undefined
      const imagePolicy = resolveRequestImagePolicy(found)
      if (typeof attachments?.readImageRequest === 'function') {
        loadImage = (ref) => attachments.readImageRequest(ref, imagePolicy, signal)
      } else {
        log(this.ctx, 'warn', `[${model}] image content present but attachment service unavailable; falling back to text-only`)
      }
    }

    const useAnthropic = ANTHROPIC_PROTOCOL_MODELS.has(model)

    // Anthropic 协议：system 顶层、工具 input_schema、工具结果回成 user 块；
    // OpenAI 协议：system 在 messages 里、工具 parameters、工具结果 role:'tool'。
    let body
    let translator
    if (useAnthropic) {
      const wire = await serializeAnthropicMessages(messages, system, loadImage, { ctx: this.ctx, modelId: model, signal, sessionId })
      const wireTools = serializeAnthropicTools(tools)
      body = {
        model,
        ...(wire.system ? { system: wire.system } : {}),
        messages: wire.messages,
        stream: true,
        max_tokens: maxTokens || Number(found?.maxTokens) || DEFAULT_MAX_TOKENS,
        ...(temperature !== undefined ? { temperature: Math.max(0, Math.min(1, temperature)) } : {}),
        ...(wireTools ? { tools: wireTools } : {}),
      }
      translator = new AnthropicStreamTranslator(() => JSON.stringify(wire.messages))
    } else {
      const wireMessages = await serializeMessages(messages, system, loadImage, { ctx: this.ctx, modelId: model, signal, sessionId })
      const wireTools = serializeTools(tools)
      body = {
        model,
        messages: wireMessages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens || Number(found?.maxTokens) || DEFAULT_MAX_TOKENS,
        top_p: 0.95,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(wireTools ? { tools: wireTools, tool_choice: 'auto' } : {}),
        ...(effort ? { reasoning_effort: effort } : {}),
      }
      translator = new StreamTranslator(() => JSON.stringify(wireMessages))
    }

    // 续跑请求构造：Anthropic 只回放正文（thinking 块缺 signature 会被拒）
    const continuationOf = useAnthropic ? buildAnthropicContinuationBody : buildContinuationBody

    let continuationsLeft = MAX_CONTINUATIONS
    let emptiesLeft = EMPTY_STREAM_RETRIES
    let cutStep = 0
    let lastError = null

    // 开一条流并泵完，产出翻译事件；返回结束状态。
    // 泵中途异常（网络中断/看门狗掐流）不外抛——按断流处理，由恢复循环决策。
    const self = this
    const runOnce = async function* (reqBody) {
      const { response } = await self.openStreamOnce(reqBody, options)
      const marks = { done: false }
      try {
        yield* translator.pump(useAnthropic ? parseAnthropicSse(response, marks) : parseSse(response, marks), marks)
      } catch (err) {
        if (signal?.aborted) throw aborted()
        lastError = err
      }
      // 三种非健康结局：无声断流(有产出/无产出)、干净但空响应。
      // "干净但空"是免费档第三种断法——上游带着 finish_reason 返回
      // 零内容(outputTokens=0)，看似合法实为负载卸载，必须重试。
      if (marks.done || translator.sawFinishReason) {
        return translator.openedBlocks ? 'clean' : 'empty-clean'
      }
      return translator.openedBlocks ? 'aborted-mid' : 'aborted-empty'
    }

    // 恢复请求自身开流失败时：若已有部分交付则降级为优雅收尾（内容不陪葬），
    // 若全程零交付则如实上抛。
    const attemptRun = async function* (reqBody) {
      try {
        return yield* runOnce(reqBody)
      } catch (err) {
        if (signal?.aborted || !translator.openedBlocks) throw err
        log(self.ctx, 'warn', `recovery request failed (${err.message || err.code || 'unknown'}); finalizing partial output`)
        return 'clean'
      }
    }

    let status = yield* attemptRun(body)
    while (status !== 'clean') {
      const wait = truncationBackoff(cutStep++)
      if (status === 'aborted-empty' || status === 'empty-clean') {
        // Anthropic 线专属兜底：该线（union-alpha）的长生成流式恒返回
        // HTTP 200 + 空 body，重试流式没有意义；直接退回非流式即可稳定取回。
        // 只在整个回复尚未产出任何块时启用——已交付半截内容时仍走续跑逻辑。
        if (useAnthropic && !translator.openedBlocks) {
          log(this.ctx, 'warn', `[${model}] empty stream; falling back to non-streaming request`)
          let json = null
          try {
            json = await this.fetchOnceNonStreaming(body, options)
          } catch (err) {
            if (signal?.aborted) throw aborted()
            lastError = err
          }
          if (json) {
            const evs = anthropicMessageToEvents(json, () => JSON.stringify(body.messages))
            for (const ev of evs) yield ev
            return
          }
          break
        }
        if (emptiesLeft-- <= 0) break
        log(this.ctx, 'warn', `[${model}] ${status === 'empty-clean' ? 'upstream returned an empty response (finish without content)' : 'upstream aborted an empty stream'}; retry #${EMPTY_STREAM_RETRIES - emptiesLeft} in ${wait}ms`)
      } else if (continuationsLeft > 0 && translator.continuable) {
        // 思考/正文半截：无缝续跑（同一块续流）
        continuationsLeft--
        log(this.ctx, 'warn', `[${model}] stream cut mid-generation; auto-continue #${MAX_CONTINUATIONS - continuationsLeft} in ${wait}ms`)
        await sleepOrAbort(wait, signal)
        status = yield* attemptRun(continuationOf(body, translator.snapshotPartial()) || body)
        continue
      } else if (continuationsLeft > 0 && translator.toolBlocks.size > 0) {
        // 工具调用参数被掐：残参隔离成合法但必失败的 JSON，整轮重打。
        // 不走续跑——把残缺 tool_call 回传历史有网关格式风险，重打最干净。
        continuationsLeft--
        translator.quarantinePartialTools()
        log(this.ctx, 'warn', `[${model}] stream cut mid-tool-call; args quarantined, full retry in ${wait}ms`)
        await sleepOrAbort(wait, signal)
        status = yield* attemptRun(body)
        continue
      } else {
        break // 恢复预算耗尽：优雅收尾已交付内容
      }
      await sleepOrAbort(wait, signal)
      status = yield* attemptRun(body)
    }

    if (status !== 'clean' && !translator.openedBlocks) {
      // 全程零交付：如实抛错让上层感知，而不是伪造一次成功
      throw Object.assign(
        lastError || new Error('OpenCode Zen stream ended without any data'),
        { code: 'TRANSPORT' },
      )
    }
    yield* translator.finalize()
  }
}

function aborted() {
  const e = new Error('OpenCode Zen request aborted by caller')
  e.code = 'ABORTED'
  return e
}

function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new OpenCodeZenAdapter(ctx))
  const keys = loadPoolKeys()
  // 启动即后台拉取实时目录：选择器首次打开即为最新 free 列表（失败回退静态）
  ensureLiveModels(ctx).catch(() => {}).finally(() => {
    const ms = currentModels()
    log(ctx, 'info', `provider "${PROVIDER}" registered, ${ms.length} free models (live), ${keys.length} key(s) in rotation`)
  })
}

module.exports = { apply, inject, name, OpenCodeZenAdapter, StreamTranslator, AnthropicStreamTranslator, buildContinuationBody, buildAnthropicContinuationBody, anthropicMessageToEvents, describeRequest, extractDescribeText, truncationBackoff, serializeMessages, serializeAnthropicMessages, serializeAnthropicTools, parseAnthropicSse, multimodalParts, visionDescribe, visionDescribeBackground, VISION_DESC_CACHE, inputModalitiesOf, isFreeModelId, wireProtocolOf, ANTHROPIC_PROTOCOL_MODELS, PROVIDER, MODELS, resolveApiKey, zenHeaders, normalizeSessionId }