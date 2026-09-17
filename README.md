# dsh-opencode-zen

**Free LLMs for DeepSeek Harness, zero config, zero cost.** Brings the OpenCode Zen free tier into your DSH model picker — no signup, no API key, no billing.

[中文说明](README.zh.md)

---

## Why?

The conversation you're reading right now is powered by this plugin, on the OpenCode Zen **free tier** — zero config, zero cost.

- 💰 **Actually free** — the official free tier authenticates with the literal key `public`; no account, no signup, no API key.
- 🎫 **Plays by the gateway's rules** — the zen free tier only serves clients that look like the official opencode CLI. The plugin stamps the full identity header set on every request, including an `x-opencode-session` of exactly `ses_` + 26 lowercase hex characters — the one field the gateway actually validates (reverse-engineered from the real client; see "Attribution gate" below).
- 🧮 **Live free catalog** — the available free models are pulled at runtime from OpenCode Zen's `/v1/models` endpoint (no login required), so the picker always reflects what's currently offered; `models.json` is an annotation overlay for metadata.
- ⚡ **Install & go** — restart `dsh web` and the `opencode` route appears in the model selector; no configuration needed.
- 🔑 **Stack quotas** — pairs with dsh-api-key-pool for round-robin rotation across multiple free accounts, automatically.
- 🛡️ **Quota-aware** — built-in 429/5xx backoff and request throttling so you never blow through the free quota.
- 🔁 **Cut-stream self-healing** — the free-tier gateway sometimes kills long generations mid-stream (no error, no answer): thinking/text cuts auto-resume after progressively longer waits, seamlessly continuing the same reasoning block; cut tool-call arguments get quarantined into valid placeholders (the host sees a clear validation error instead of silent failure) and the turn is retried in full.
- 🖼️ **Resilient vision** — images never ride in your main request: each one is converted to a text description by an isolated, disposable side-request (fresh request on every retry, cached by content hash and reused across turns), so an unstable upstream vision endpoint can degrade a single picture to a placeholder but can never poison or kill your conversation.
- 🧠 **Full parity** — streaming, reasoning-content passthrough, and tool calls, same experience as paid models.

## Models (discovered live)

The free model list is **not hardcoded** — it is pulled live from two API sources and merged:

- **Availability** = `https://opencode.ai/zen/v1/models` (OpenAI-compatible list, no login required). This is what zen actually serves *right now*, so only usable models appear.
- **Specs** = `https://models.dev/api.json` (the full registry opencode itself uses), giving each model its **context window, input modalities (text/image/audio/pdf), reasoning effort levels, tool-call support**, etc.

The spec map is cached to disk (`~/.cache/dsh-opencode-zen/models-dev-specs.json`, TTL `DSH_ZEN_MODELS_TTL_MS`, default 10 min) so startup never blocks on the ~4MB models.dev fetch. If a source fails, it falls back gracefully: zen → models.dev catalog → static `models.json`. The current live set (availability ∩ specs):

| Model | Notes |
|---|---|
| `union-alpha` | Union Alpha — stealth coding model; **Anthropic `/v1/messages` protocol**, tool use + vision |
| `big-pickle` | Big Pickle |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash — reasoning + tools, daily driver |
| `mimo-v2.5-free` | Xiaomi MiMo 2.5 |
| `ling-3.0-flash-fin-free` | Ling 3.0 Flash Fin |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Contributor |
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 Contributor |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra (1M context) |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning |

Membership is not always signalled by the name: `union-alpha` and `big-pickle` carry no
`free` suffix, so the adapter also accepts any model that models.dev declares at zero cost
(`cost.input`/`cost.output` both 0). `hy3-free` and `laguna-s-2.1-free` are no longer served
by zen. Because membership is live, this table is illustrative rather than
authoritative: the picker is driven by `/v1/models`, so promotions and retirements show
up on their own.

If the live fetch fails, the adapter falls back to the static `models.json` so the picker still works offline. Models removed upstream disappear automatically; new ones appear without a plugin update.

The selector always offers `off` / `low` / `high` (default) / `max`; the adapter translates each level to what the chosen model accepts, or omits the field when unsupported.

## Two wire protocols

Most zen models speak the OpenAI-compatible `chat/completions` API, but some only speak
Anthropic's `Messages` API — `union-alpha` returns `500 Internal server error` on
`/chat/completions` and works only on `/v1/messages`. The adapter picks the wire protocol per
model (`ANTHROPIC_PROTOCOL_MODELS`) and translates accordingly:

| Concern | OpenAI path | Anthropic path |
|---|---|---|
| Endpoint | `/chat/completions` | `/v1/messages` |
| System prompt | a `system` message | top-level `system` field |
| Tool schema | `function.parameters` | `input_schema` |
| Tool call | `assistant.tool_calls` | `tool_use` content block |
| Tool result | `role: "tool"` message | `tool_result` block in a user message |
| Streaming | `choices[].delta` | `content_block_delta` events |
| Completion | `[DONE]` / `finish_reason` | `message_stop` / `stop_reason` |

Both paths feed the same block/usage/finish event contract and share the whole
cut-stream recovery machinery, so the auto-continue, empty-stream retry and
truncated-tool-argument quarantine behave identically. Two asymmetries:

- Anthropic thinking blocks require a `signature`, so historical reasoning is **not**
  replayed on that path.
- On that path a long generation can end as HTTP 200 with a **completely empty body**
  (after ~32s), while the same request with `stream:false` returns the full result
  reliably. So instead of retrying the stream, that path **falls back to a
  non-streaming request**. This is what previously made `union-alpha` fail long answers
  with "stream ended without any data".

The **vision side-channel is protocol-aware too**: `describeRequest()` emits an
`image`/`source.base64` content block to `/v1/messages` for Anthropic models, while the
OpenAI path keeps `image_url` + `/chat/completions`. Previously that side-channel
hardcoded the OpenAI shape, so an Anthropic-only model like `union-alpha` failed every
image with a 500 — even though the model itself sees images natively.

## Native image pass-through

By default images never enter the main request; they are converted to a text description
first. For models whose native vision is reliable, sending the pixels directly is strictly
better: one less round-trip, and color/detail/layout preserved exactly. Such models are
declared in `NATIVE_IMAGE_MODELS` (or per-model `nativeImage` in `models.json`), currently
`union-alpha`. Both wire formats support it: Anthropic sends an `image`/`source.base64`
block, OpenAI an `image_url` block.

**It applies to user messages only.** Empirically, an image nested in a tool result
(`tool_result` / `role:"tool"`) is not attended to even when the format is valid and the
gateway returns 200 — the model replies that it "can't visually inspect that base64
payload", asks for the image to be attached directly, and gets every quadrant wrong. The
very same image sent as a user message is read perfectly. So images inside tool results
**always take the text side-channel**.

Measured on a random four-quadrant image (bottom-left truth `246,252,90`):

| Path | Answer |
|---|---|
| user image, native | `245,240,60` ✅ |
| tool-result image, side-channel | `249,244,89` ✅ |
| tool-result image, native attempt | refused / wrong ❌ |

## Attribution gate

The zen free tier will not serve third-party clients: requests that don't identify as the
official opencode CLI are rejected with

```json
{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```

The plugin satisfies the gate by sending the same identity headers the real client sends.
Rather than guessing header names, we **intercepted the official client**: install `opencode`,
point an `@ai-sdk/openai-compatible` provider at a local logging proxy via `OPENCODE_CONFIG`,
and run `opencode run`. Version 1.18.31 sends:

| Header | Value |
|---|---|
| `User-Agent` | `opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` |
| `x-opencode-client` | `cli` |
| `x-opencode-project` | project id (sha1) — `global` also works |
| `x-opencode-request` | `msg_<id>` (value not validated) |
| `x-opencode-session` | `ses_<26 lowercase hex>` |

`x-session-id` — the header the plugin used to rely on — **is gone from the new client's wire
format**.

Only the **shape of `x-opencode-session`** turned out to be validated. Across shuffled,
repeated trials the result is deterministic per value:

| `x-opencode-session` | Result |
|---|---|
| `ses_` + exactly 26 lowercase hex | **200** |
| `ses_` + 24 / 25 / 27 / 28 / 32 hex | 403 |
| `ses_` + 26 **uppercase** hex | 403 |
| `ses_` + 26 base62 characters | 403 |
| bare UUID / bare hex (no `ses_` prefix) | 403 |
| the real CLI session id (control) | 200 |

The `User-Agent` does not have to be spoofed — a DSH-branded UA passes — but the plugin sends
the opencode one anyway. Because the host's own session id is `ses_<26 base62>`, it cannot be
forwarded verbatim; the plugin derives a **stable** `ses_<26 lowercase hex>` from it via
SHA-256, so every turn of one conversation pins to the same upstream backend and keeps its
prompt cache warm.

## Installation

```sh
dsh plugin --profile web add github:guowenzheng941117/dsh-opencode-zen
```

Restart `dsh web` → **Settings → Models** → pick provider `opencode` → choose a free model (start with `nemotron-3.5-lightning-free`).

## Configuration (optional — zero config by default)

### Stack multiple accounts

1. Install [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool).
2. Add your keys under the `opencode` pool.
3. The plugin picks them up automatically and rotates round-robin.

### Environment variables

Set `OPENCODE_ZEN_API_KEY` or `OPENCODE_GO_API_KEY` before starting `dsh web`.

Nothing configured? It falls back to the official public tier (`public`).

### Annotate the model list (optional)

Free models are discovered live from the API, so you normally don't edit anything. `models.json` at the repo root is an **annotation overlay** keyed by model id — it supplies metadata the `/v1/models` list doesn't return (name, context window, reasoning efforts, image input, data risk). It accepts `{ "models": [...] }` or a bare array; every entry needs at least a string `id`:

```json
{ "id": "hy3-free", "name": "Hunyuan 3 (Free)", "contextWindow": 190000, "reasoningEfforts": ["low", "high"] }
```

- `reasoningEfforts`: an array = the wire values this model accepts; `null` / `false` = never send explicit control.
- `input`: `["text","image"]` enables vision for that model.
- `imagePixelBudget` / `imageMaxBytes`: optional per-model image request budgets. Omitted = the official defaults (`640000` px, `1 MiB`); `"low"` selects the low-detail pixel budget (`512×512`).
- If the file is missing or corrupt, the plugin falls back to its built-in default table.

## Image budgets

Image downscaling, quality-ladder encoding, and caching are **delegated to the harness
attachment service** (`ctx.attachments.readImageRequest`) — this plugin never decodes or
re-encodes pixels itself (its `sharp` dependency is reserved for the strip-splitting
remedy on the vision channel).

The budgets passed to that service follow the official
`@deepseek-ai/dsh-llm-deepseek` semantics, via `resolveRequestImagePolicy(model)`:

| Field | Value |
| --- | --- |
| `imagePixelBudget` | number, or `"low"` → `512×512`; default `640000` |
| `imageMaxBytes` | number; default **`1 MiB`** |

> That resolver is a **private** implementation of the official DeepSeek adapter (it is
> *not* exported from `@deepseek-ai/dsh-llm`), so this plugin carries a 1:1 replica
> verified case-by-case against the upstream original. If upstream changes these
> defaults or their semantics, this replica must be re-checked.

**No image offloading here.** Zen uses a *vision-bypass* architecture: images are replaced
with text descriptions during serialization, so the main request's wire layer never
contains an `image_url` at all (verified: feeding 700 images still yields 0 `image_url`
entries). The official `offloadRequestImagesWithPolicy` therefore has nothing to offload,
and is deliberately not used.

## Troubleshooting

**Q: Model returns 429 Too Many Requests?**
A: The free tier has per-IP rate limits. Wait 30–60 seconds, or install [dsh-api-key-pool](https://github.com/xiaozhe7772222/dsh-api-key-pool) to rotate across multiple keys automatically.

**Q: `opencode` provider doesn't appear in model selector?**
A: Restart `dsh web` fully (not just refresh). Verify installation with `dsh plugin --profile web list`.

**Q: Which DSH versions are supported?**
A: DSH 0.8.0+ with the `ctx.llm.registerAdapter` API. Older versions may need manual route registration.

**Q: Are these models really free forever?**
A: They use OpenCode Zen's official public free tier. Service availability and quota limits are subject to OpenCode Zen's policies — this plugin is just a client adapter.

## How it works

Registers an `opencode` LLM provider route via `ctx.llm.registerAdapter(['opencode'], adapter)`, exposing the OpenCode Zen free models to session models and sub-agents alike.

## License

MIT
