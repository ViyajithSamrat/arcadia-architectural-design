# Provider verification status (Phase 5)

Written 2026-10-18. This records what was verified, how, and what is still unknown. **No call to OpenRouter or Gnani has been made from this code base**: every adapter is tested only with a fake `fetch`, and the default test run blocks the real network (`tests/unit/support/no-network.ts`). "Documented" below means "read in the provider's official documentation", not "tested against the service".

## Modes

- `PROVIDER_MODE` unset or `mock`: the labelled mock brief provider. No network, no usage records.
- `PROVIDER_MODE=live`: OpenRouter for the brief, only if `OPENROUTER_API_KEY` and `OPENROUTER_TEXT_MODEL` are set; otherwise the brief says it is unavailable. It never falls back to the mock silently.
- Voice (Gnani) is **off** unless `GNANI_VOICE_ENABLED=true` and every safeguard in `getGnaniReadiness` has a value. No voice route or screen exists yet; only the adapters and the budget guard do.

## OpenRouter (text, brief)

| Item | Finding | Status |
|---|---|---|
| Endpoint | `POST https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer <key>`, optional `HTTP-Referer` and `X-Title` | documented |
| Structured output | `response_format: {type: "json_schema", json_schema: {name, strict, schema}}`; support is per endpoint, so the request also sets `provider.require_parameters: true` | documented; the exact type of `message.content` is not stated, so the adapter accepts a string or an object |
| Free models | ids ending `:free`; 20 requests/minute; 50 requests/day with under $10 of credits ever purchased (1000/day otherwise); HTTP 429 beyond that | documented |
| Privacy of free models | not stated on the limits page | **unknown: use synthetic demo data only** |
| Model id | not chosen: set `OPENROUTER_TEXT_MODEL` to a `:free` model whose endpoint lists `structured_outputs`, checked on the models page the day you use it | **open** |
| Live behaviour | never exercised | **unverified** |

What the model is trusted with: the wording of the brief only. The server composes everything else from the customer's validated answers, rejects any extra field, any number that is not in the customer's data, and any construction-ready / code-compliance claim. The adapter makes exactly one request (no automatic retry) so a free model's daily quota is not burned.

## Gnani (speech)

| Item | Finding | Status |
|---|---|---|
| STT | `POST https://api.vachana.ai/stt/v3`, multipart `audio_file` + `language_code`, header `X-API-Key-ID`; response `{success, transcript, request_id?}` | documented (docs.gnani.ai) |
| STT limits | 60 s per request on one page, 30 s on another (the adapter and config cap at 30); no file-size limit stated; WAV/MP3/OGG/FLAC/AAC/M4A | documented, conflicting |
| STT languages | bn/en/gu/hi/kn/ml/mr/pa/ta/te-IN | documented |
| TTS | `POST https://api.vachana.ai/api/v1/tts/inference`, JSON `{text, model, voice, language, speed, audio_config}`, returns raw audio bytes; models `timbre-v2.5`, `timbre-v3.0` | documented |
| Authentication | `X-API-Key-ID` header | documented. A Gnani developer page shows a different host (`api.gnani.ai/prisma`, `/timbre`) with Bearer auth. **The owner must confirm which is current for their account.** Only `api.vachana.ai` is allowed in code. |
| Credit accounting | **no price, credits per second or per character is documented, and the STT response reports no usage** | **unknown** |
| Browser recording | Chrome/Edge record WebM/Opus, which is not a documented format; the design is to encode WAV in the browser | design decision, untested |
| Live behaviour | never exercised | **unverified** |

### Budget rules in force (owner decision)

- 5,000 credits is an absolute ceiling (`GNANI_HARD_CEILING_CREDITS`); `GNANI_BUDGET_CREDITS` can only be lower.
- Because Gnani reports no usage, every call is an **estimate** from the owner's own `GNANI_CREDITS_PER_STT_SECOND` and `GNANI_CREDITS_PER_TTS_CHAR`, rounded up. If either is unset the guard refuses every call (fail closed). A failed call still counts at its estimate.
- Also required: `GNANI_MAX_CREDITS_PER_REQUEST`, `GNANI_CUSTOMER_CREDITS_PER_HOUR`.
- One Gnani call at a time, provider-wide (`maxInFlight: 1`), no automatic retry, never in browser or unit tests.
- Any Gnani call, even a test, needs the owner's explicit approval first.

## Request limits and the usage ledger

`ai_usage` (migration `20261018000200_ai_usage.sql`, revised after a SQL audit and **applied to the LOCAL Supabase database only**) records every provider call before it is made. `ai_usage_reserve` checks the per-customer limit, the provider-wide ceiling (clamped to 5,000 credits in SQL for Gnani) and the in-flight cap in one serialized transaction; `ai_usage_finish` records the outcome. `audit_events` was rejected as the ledger: it is append-only, admin-read-only and tied to workflow events. Not verified: hosted Supabase, a hosted connection pooler, and the rollback on real PostgreSQL (in-memory only).

OpenRouter limits (all environment-tunable, bounded in code): `AI_BRIEFS_PER_HOUR` (default 5 per customer), `OPENROUTER_DAILY_REQUEST_CAP` (default 40 across the app, below the free tier's 50).

## Tests: mocked versus live

The Phase 5 adapter tests are mocked (fake `fetch`, fake database client, in-memory Postgres). The budget guard is additionally tested against the real LOCAL PostgreSQL stack (`tests/live/ai-usage-live.live.test.ts`; no provider is contacted). No live OpenRouter or Gnani test exists yet. Live smoke tests, when approved, must be separate opt-in scripts (`LIVE_OPENROUTER=1`, `LIVE_GNANI=1`) using synthetic data. Last recorded results (migration-application session, 2026-10-20; not re-run when this text was written): `npm test` 566/566, local live suite 80/80.
