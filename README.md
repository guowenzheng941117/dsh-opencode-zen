# dsh-opencode-zen

**Free LLMs for DeepSeek Harness, zero config, zero cost.** Brings the OpenCode Zen free tier into your DSH model picker — no signup, no API key, no billing.

[中文说明](README.zh.md)

---

## Why?

The conversation you're reading right now is powered by this plugin, on the OpenCode Zen **free tier** — zero config, zero cost.

- 💰 **Actually free** — the official free tier authenticates with the literal key `public`; no account, no signup, no API key.
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
| `hy3-free` | Tencent Hunyuan Hy3 |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash — reasoning + tools, daily driver |
| `mimo-v2.5-free` | Xiaomi MiMo 2.5 |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Contributor |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning |
| `laguna-s-2.1-free` | Laguna S 2.1 |

If the live fetch fails, the adapter falls back to the static `models.json` so the picker still works offline. Models removed upstream disappear automatically; new ones appear without a plugin update.

The selector always offers `off` / `low` / `high` (default) / `max`; the adapter translates each level to what the chosen model accepts, or omits the field when unsupported.

## Installation

```sh
dsh plugin --profile web add github:guowenzheng941117/dsh-opencode-zen
```

Restart `dsh web` → **Settings → Models** → pick provider `opencode` → choose a free model (start with `x-preview-f-free`).

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
- If the file is missing or corrupt, the plugin falls back to its built-in default table.

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
