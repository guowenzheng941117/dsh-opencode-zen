# dsh-opencode-zen

**Free LLMs for DeepSeek Harness, zero config, zero cost.** Brings the OpenCode Zen free tier into your DSH model picker — no signup, no API key, no billing.

[中文说明](README.zh.md)

---

## Why?

The conversation you're reading right now is powered by this plugin: **Ox Alpha (`x-preview-f-free`) with a 1M-token window, on the free tier, for free.**

- 💰 **Actually free** — the official free tier authenticates with the literal key `public`; no account, no signup, no API key.
- 🧮 **Three free models** — Ox Alpha, Tencent Hunyuan Hy3, Xiaomi MiMo 2.5; the catalog lives in `models.json`, edit it freely.
- ⚡ **Install & go** — restart `dsh web` and the `opencode` route appears in the model selector; no configuration needed.
- 🔑 **Stack quotas** — pairs with dsh-api-key-pool for round-robin rotation across multiple free accounts, automatically.
- 🛡️ **Quota-aware** — built-in 429/5xx backoff and request throttling so you never blow through the free quota.
- 🧠 **Full parity** — streaming, reasoning-content passthrough, and tool calls, same experience as paid models.

## Models (as configured in `models.json`)

| Model | Context window | Reasoning efforts | Notes |
|---|---|---|---|
| `x-preview-f-free` | 1M | low / high (default) / max | Ox Alpha · zero retention, no training; daily driver |
| `hy3-free` | 190k | low / high (default) | Tencent Hunyuan Hy3 |
| `mimo-v2.5-free` | 200k | no explicit control | Xiaomi MiMo 2.5 |

The selector always offers `off` / `low` / `high` (default) / `max`; the adapter translates each level to what the chosen model actually accepts, or omits the field when unsupported.

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

### Customize the model list

The model catalog is externalized in `models.json` at the repo root. It accepts `{ "models": [...] }` or a bare array; every entry needs at least a string `id`:

```json
{ "id": "x-preview-f-free", "name": "Ox Alpha Free", "contextWindow": 1000000, "reasoningEfforts": ["low", "high", "max"] }
```

- Add/remove entries to change the picker; restart `dsh web` to apply.
- `reasoningEfforts`: an array = the wire values this model accepts; `null` / `false` = never send explicit control.
- If the file is missing or corrupt, the plugin falls back to its built-in six-model default table.

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
