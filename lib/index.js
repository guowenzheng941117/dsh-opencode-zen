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

const { readFileSync, existsSync, appendFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { homedir } = require('node:os')
const name = 'dsh-opencode-zen'
const inject = ['llm']

const PROVIDER = 'opencode'
const OPENCODE_BASE = 'https://opencode.ai/zen/v1'
const OPENCODE_UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const POOL_FILE = join(homedir(), '.dsh', 'profiles', 'web', 'plugins', 'dsh-api-key-pool', 'pool-config.json')

const MODELS_FILE = join(__dirname, '..', 'models.json')

/** 内置默认表：仅当 models.json 缺失或损坏时兜底使用 */
const DEFAULT_MODELS = [
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash (Free)', contextWindow: 200000, description: 'OpenCode Zen 免费档：推理 + 工具调用，日常主力' },
  { id: 'mimo-v2.5-free', name: 'MiMo 2.5 (Free)', contextWindow: 200000, description: 'OpenCode Zen 免费档' },
  { id: 'hy3-free', name: 'Hunyuan 3 (Free)', contextWindow: 200000, description: 'OpenCode Zen 免费档（腾讯混元）' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra (Free)', contextWindow: 131072, description: 'OpenCode Zen 免费档（NVIDIA）' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning (Free)', contextWindow: 131072, description: 'OpenCode Zen 免费档（NVIDIA）' },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 (Free)', contextWindow: 200000, description: 'OpenCode Zen 免费档' },
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

const REASONING_LEVELS = [
  { id: 'off', name: 'Off', description: '不思考，最快' },
  { id: 'low', name: 'Low', description: '轻量思考' },
  { id: 'high', name: 'High', description: '深度思考（默认）' },
  { id: 'max', name: 'Max', description: '极限思考，最耗额度' },
]

const DEFAULT_REASONING = 'high'

/**
 * dsh 推理等级(off/low/high/max) → 上游 reasoning_effort 词汇的翻译表。
 * 上游(OpenCode Zen)只认 no_think/low/high，没有 max；off 若不显式发
 * no_think 会被上游按默认档计费思考。各模型如接受不同词汇集，
 * 可在 models.json 条目里加 "reasoningEfforts": [...] 覆盖。
 */
const REASONING_WIRE_MAP = { off: 'no_think', low: 'low', high: 'high', max: 'high' }
const DEFAULT_REASONING_EFFORTS = ['low', 'high']

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
const DEFAULT_MAX_TOKENS = 128000
const DEFAULT_CONTEXT_WINDOW = 200000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30000
const MAX_REQUEST_ATTEMPTS = 4
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

/** 图片输入：像素投影预算与单请求 base64 总量上限（对齐官方视觉投影口径） */
const DEFAULT_MAX_IMAGE_PIXELS = 640000
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024

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
/** 描述缓存上限（按 LRU 粗略淘汰）；键 = 图片字节 sha1 + 尺寸 */
const VISION_CACHE_CAP = 200
const VISION_DESC_CACHE = new Map()

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
          try {
            // 内联等待受硬预算约束：预算内拿不到（含上游挂起/缓存中尚未就绪的
            // 后台补描）立即放弃，主请求绝不为视觉通道多等一毫秒
            description = await Promise.race([
              visionDescribe(visCtx?.ctx, visCtx?.modelId, v, visCtx?.signal),
              sleepOrAbort(DESCRIBE_INLINE_BUDGET_MS, visCtx?.signal).then(() => {
                throw Object.assign(new Error('inline budget exceeded'), { code: 'TIMEOUT' })
              }),
            ])
          } catch (err) {
            log(visCtx?.ctx, 'warn', `vision describe unavailable inline (${err?.code || err?.message || 'unknown'}); degrading to placeholder, background respawn queued`)
            visionDescribeBackground(visCtx?.ctx, visCtx?.modelId, v)
          }
          parts.push({
            type: 'text',
            text: description
              ? `[image ${v.width}x${v.height}px]\n${description}`
              : `[image ${v.width}x${v.height}px unavailable: vision channel failed]`,
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

/**
 * 视觉旁路"子代理"：用一次独立、可丢弃的 chat.completions 把图片换成文字描述。
 * - 每次尝试都是全新请求（新连接新上下文），失败即重派，互不污染；
 * - 结果按图片字节 sha1 缓存：首轮成功后每轮复用，不再重复上传像素；
 * - 全部尝试失败则抛错，由调用方降级为占位符——主流程永不被视觉端点拖死。
 * 刻意不走 openStreamOnce/stream 翻译管线：这是非流式单发 JSON，且绝不能递归进自身恢复逻辑。
 */
async function visionDescribe(ctx, modelId, v, signal, opts) {
  const rounds = opts?.rounds || DESCRIBE_ATTEMPTS
  const key = describeCacheKey(v)
  // force=true（后台补描专用）：无视现存条目——那可能是即将失败的孤儿内联请求，
  // 附着上去只会陪葬；后台必须跑自己的全新重试链
  if (!opts?.force) {
    const cached = VISION_DESC_CACHE.get(key)
    if (cached) return cached
  }
  const attempt = (async () => {
    let lastError = null
    for (let i = 0; i < rounds; i++) {
      if (signal?.aborted) throw aborted()
      const controller = new AbortController()
      const state = { selfAbort: '' }
      const timer = setTimeout(() => { state.selfAbort = 'timeout'; controller.abort() }, DESCRIBE_TIMEOUT_MS)
      try {
        const response = await fetch(`${OPENCODE_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${resolveApiKey()}`,
            'User-Agent': OPENCODE_UA,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: DESCRIBE_PROMPT },
                { type: 'image_url', image_url: { url: `data:${v.mediaType || 'image/png'};base64,${Buffer.from(v.data).toString('base64')}` } },
              ],
            }],
            max_tokens: DESCRIBE_MAX_TOKENS,
            reasoning_effort: 'low',
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          lastError = new Error(`describe HTTP ${response.status}: ${raw.slice(0, 120)}`)
          lastError.code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
          if (lastError.code === 'PROVIDER_ERROR') break // 4xx 换多少个新请求结果都一样，别烧额度
        } else {
          const json = await response.json().catch(() => null)
          const text = typeof json?.choices?.[0]?.message?.content === 'string' ? json.choices[0].message.content.trim() : ''
          if (text) return text
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
function visionDescribeBackground(ctx, modelId, v) {
  const key = describeCacheKey(v)
  if (VISION_BG_ACTIVE.has(key)) return
  VISION_BG_ACTIVE.add(key)
  const attempt = visionDescribe(ctx, modelId, v, undefined, { rounds: DESCRIBE_BACKGROUND_ROUNDS })
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
          this.toolBlocks.set(idx, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        const fn = call.function || {}
        if (call.id) block.callId = call.id
        if (fn.name) block.name = fn.name
        if (fn.arguments) {
          block.text += fn.arguments
          yield { type: 'tool-call-delta', index: block.index, name: block.name || '', argumentsDelta: fn.arguments }
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
  listModels() {
    return Promise.resolve(MODELS.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, description: m.description, inputModalities: inputModalitiesOf(m) })))
  }
  resolveModel(provider, model) {
    const found = MODELS.find((m) => m.id === model)
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
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
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
    let lastError = null
    let retryAfterMs = 0
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw aborted()
      const controller = new AbortController()
      // selfAbort: 区分"自身超时中止"(connect/idle，按 TIMEOUT 走重试)与"调用方取消"(原样上抛)
      const state = { selfAbort: '' }
      const onAbort = () => controller.abort()
      const connectTimer = setTimeout(() => { state.selfAbort = 'connect'; controller.abort() }, options.timeoutMs || CONNECT_TIMEOUT_MS)
      if (signal) signal.addEventListener('abort', onAbort)
      try {
        let response
        try {
          response = await fetch(`${OPENCODE_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${resolveApiKey()}`,
              'User-Agent': OPENCODE_UA,
            },
            body: JSON.stringify(reqBody),
            signal: controller.signal,
          })
        } finally {
          clearTimeout(connectTimer)
        }

        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          const code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
          const err = new Error(`OpenCode Zen HTTP ${response.status}: ${raw.slice(0, 300)}`)
          err.code = code
          if (code === 'PROVIDER_ERROR') { err.fatal = true; throw err }
          const ra = Number(response.headers?.get?.('retry-after'))
          retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0
          lastError = err
        } else {
          response = attachIdleWatch(response, controller, signal, () => { state.selfAbort = 'idle' })
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
   * 对外主入口。恢复矩阵：
   * - 上游干净结束（[DONE]/finish_reason）→ 正常收尾
   * - 空流中断（零输出）→ 整单重试 EMPTY_STREAM_RETRIES 次
   * - 半截中断（思考/正文已流出）→ 递增间隔后自动续跑 MAX_CONTINUATIONS 次
   * - 工具调用参数被掐 → 残参隔离成合法但必失败的 JSON（宿主得到明确
   *   校验错误而非静默失败），然后整轮重打
   * - 恢复预算耗尽 → 优雅收尾已交付的内容（工具参数仍保证合法）
   * 断流等待绝不立即重试：truncationBackoff(cutStep++) 递增 + 大抖动。
   */
  async *stream(options) {
    const { model, messages, system, tools, maxTokens, reasoningEffort, temperature, signal } = options

    const found = MODELS.find((m) => m.id === model)
    const effort = pickReasoningEffort(reasoningEffort, found)

    // 图片输入：模型声明支持时，从宿主附件服务解析字节；服务缺失则降级纯文本
    let loadImage = null
    if (found && inputModalitiesOf(found).includes('image')) {
      const attachments = typeof this.ctx?.get === 'function' ? this.ctx.get('attachments') : undefined
      if (typeof attachments?.readImageRequest === 'function') {
        loadImage = (ref) => attachments.readImageRequest(
          ref,
          { maxPixels: DEFAULT_MAX_IMAGE_PIXELS, maxBytes: DEFAULT_MAX_IMAGE_BYTES },
          signal,
        )
      } else {
        log(this.ctx, 'warn', `[${model}] image content present but attachment service unavailable; falling back to text-only`)
      }
    }

    const wireMessages = await serializeMessages(messages, system, loadImage, { ctx: this.ctx, modelId: model, signal })
    const wireTools = serializeTools(tools)

    const body = {
      model,
      messages: wireMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
      top_p: 0.95,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(wireTools ? { tools: wireTools, tool_choice: 'auto' } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    }

    const translator = new StreamTranslator(() => JSON.stringify(wireMessages))
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
        yield* translator.pump(parseSse(response, marks), marks)
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
        if (emptiesLeft-- <= 0) break
        log(this.ctx, 'warn', `[${model}] ${status === 'empty-clean' ? 'upstream returned an empty response (finish without content)' : 'upstream aborted an empty stream'}; retry #${EMPTY_STREAM_RETRIES - emptiesLeft} in ${wait}ms`)
      } else if (continuationsLeft > 0 && translator.continuable) {
        // 思考/正文半截：无缝续跑（同一块续流）
        continuationsLeft--
        log(this.ctx, 'warn', `[${model}] stream cut mid-generation; auto-continue #${MAX_CONTINUATIONS - continuationsLeft} in ${wait}ms`)
        await sleepOrAbort(wait, signal)
        status = yield* attemptRun(buildContinuationBody(body, translator.snapshotPartial()) || body)
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
  log(ctx, 'info', `provider "${PROVIDER}" registered, ${MODELS.length} free models, ${keys.length} key(s) in rotation`)
}

module.exports = { apply, inject, name, OpenCodeZenAdapter, StreamTranslator, buildContinuationBody, truncationBackoff, serializeMessages, multimodalParts, visionDescribe, visionDescribeBackground, VISION_DESC_CACHE, inputModalitiesOf, PROVIDER, MODELS, resolveApiKey }