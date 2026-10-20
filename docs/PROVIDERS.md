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

## Image generation (Phase 6A: labelled MOCK only)

**There is no real image generation.** Phase 6A built the whole server-side path with a placeholder generator so it can be tested for free; a live image provider needs a verified provider and model, credentials, a price and an owner-approved spending cap (Phase 6B, not started and not approved).

| Item | State |
|---|---|
| Provider boundary | `src/lib/providers/images.ts` (interface, output validation, timeout helper). Output is untrusted: exactly one image per requested view, at most 5 MiB (the bucket limit), real type from the file's bytes (PNG, JPEG, WebP), 64 to 4096 pixels per side read from the file's own header. |
| The mock | `src/lib/providers/mock-image.ts`: a deterministic 640 by 360 PNG with a large `MOCK — NOT A DESIGN` label and "PLACEHOLDER - NO AI MODEL USED". No network, no model, no usage, no cost. Jobs record `provider = mock` and `usage_json.mock = true`. It is **not** an architectural rendering and must never be presented as AI-generated or as a design. |
| Selection | `src/lib/generation/provider.ts`: the mock unless `PROVIDER_MODE` is `live` (any casing), which reports "Live image generation is not enabled" and changes nothing. There is no live adapter and no silent fallback. |
| Prompt | `src/lib/generation/prompt.ts`, version `image-prompt-1`. Trusted instructions are constants. Customer-derived content travels only in a separate `customerData` field (allow-listed: project type, dimensions, rooms or zones, styles, and the approved brief text capped at 1,500 characters, stripped of control characters, angle brackets and backticks). Price, budget band, payment or project status, roles, release data and reference ids are never copied. `MAX_GENERATION_IMAGES` (1 to 4, default 2) caps the images per generation request; the views each project type needs limit it further (currently 1 or 2). |
| Orchestration | `src/lib/generation/service.ts`, `startGeneration(adminSession, serviceClient, { projectId, idempotencyKey })`. Order: administrator check on the caller's own session; project and key validation; same-key replay; eligibility (`PAYMENT_VERIFIED` or `GENERATION_FAILED`, no existing generated files, valid brief); provider choice; conditional claim to `GENERATING` (the database re-checks the verified payment); job; audit event naming the administrator; `RUNNING`; one provider call with a timeout; output validation; private upload to `<project>/generated/`; unreleased asset rows; job `SUCCEEDED`; project `READY_FOR_REVIEW`. No retries, no fallback. Any failure removes what was written, marks the job `FAILED` and the project `GENERATION_FAILED`. |
| Metering | A provider that costs money sets `usage`, and the existing budget guard (`withUsage`) then reserves first and refuses without calling the provider. The mock has none, so it writes nothing to `ai_usage`. A live provider will need a **proposed Migration 8** (below). |
| Release | Unchanged: only `admin_release_project`, on the administrator's own session (`releaseProject` wraps it). Generation never releases. Until release the owner, other customers and anonymous callers cannot read the files or the asset rows, and there is no public URL. |

### Screens (Phase 6A-2, still mock only)

| Route | Who | What it does |
|---|---|---|
| `/admin/generation` | administrators (checked on the server from the database role, not from a link) | Queue of projects whose payment was verified, grouped as ready to generate, in progress or needing attention, awaiting release, released. Three reads however many rows. |
| `/admin/generation/[projectId]` | administrators | Phase and attempts for one project; **Start mock generation** / retry / resume / finish; preview of the generated images behind 60-second signed links (only for a succeeded job's files, only while the project is awaiting release or released); the persistent warning `MOCK — NOT A DESIGN. Illustrative placeholder only; not construction-ready.`; **Release** behind two explicit confirmations (a review checkbox and, for mock output, a second one) with the consequence spelled out; **Clear the interrupted job** when a job made no progress for ten minutes. A confirmation banner is shown only if the stored state agrees with it. |
| `/projects/[id]/results` | the project's owner | Before release: the status and "nothing is available to view yet", with no file, path or link read at all. After release: the conceptual-use disclaimer and the owner's released images behind 5-minute signed links. A stranger gets "not found". The project page links here only once the project is released. |

Server boundaries (the screens only ask; none of this is enforced by hiding a button):

- `startGenerationAction`, `releaseProjectAction`, `clearStaleJobAction` (`src/app/(app)/admin/generation/actions.ts`) re-check the administrator role, validate every argument and call the tested service layer. Release and clearing report a failure to the form and otherwise redirect; the page then reads the real state.
- `releaseProject` runs on the administrator's own session. It first re-reads the project and **refuses** unless it is awaiting review, no job is running, there is at least one generated file, **every generated file belongs to a succeeded job**, and, when the job was made by the mock, the administrator acknowledged that. Only then does it call `admin_release_project`.
- `getCustomerResults` checks ownership, then reads nothing unless the project is `RELEASED`; it lists only assets the database marks released and returns no storage path, only short-lived signed links made with the customer's own session (Storage allows that only for released files of the customer's own project).
- `getGenerationDetail` / `listGenerationQueue` use the administrator's session, so row level security and the storage policy decide what is visible.

### Interrupted jobs and files left behind

- A job still `QUEUED`/`RUNNING` after ten minutes without progress (`STALE_JOB_AFTER_MS`) is treated as abandoned. This is a recovery heuristic, not proof that the request stopped: only the provider call has a timeout (at most 60 seconds); storage and database calls have none and are never cancelled. `clearStaleJob` refuses a younger job, records the administrator in the audit trail **first** (if that fails, nothing is changed), then removes only that job's own unreleased files, marks it `FAILED` (`STALE_ABANDONED`), moves the project to `GENERATION_FAILED` and never calls a provider.
- If the original request is in fact still running, it cannot finish: marking its job `SUCCEEDED` is conditional on `RUNNING`. Its failure path then removes only its own files and rows, and moves the project only when its own conditional job update matched, so it cannot knock a newer run's project into `GENERATION_FAILED`. **Residual risk:** until that cleanup runs, or if the process dies before it, the late request can still store files and `design_assets` rows on its `FAILED` job, because the database checks only the job's project and the verified payment on insert, not that the job is `RUNNING`. Such files block a new run and are refused by `releaseProject`, but only the proposed database guard below would stop `admin_release_project` itself from publishing them. A database rule refusing asset inserts for a job that is not `RUNNING`, and timeouts for storage calls, are Phase 6B prerequisites.
- A project left in `GENERATING` with no job is resumed only after a minute, so two requests cannot both run the provider.
- A file left by a failed attempt (cleanup failed) is attached to a job that did not succeed. The service therefore refuses to start another run and refuses to release while it exists, and the admin screen shows "Release is blocked". **This screen cannot remove such a file**; a developer must. The database function `admin_release_project` would still publish it if called by other code, which is what the proposal below closes.

### Proposed migrations (design only: NOT applied, NOT in `supabase/migrations`)

1. **Release only succeeded jobs** — `supabase/proposed/20261020000100_release_only_succeeded_jobs.sql` with its `.down.sql`. A small trigger on `design_assets`: an asset can change from unreleased to released only if its job exists, belongs to the same project and is `SUCCEEDED`. A leftover file then makes the whole release fail and nothing is published. No existing function, policy or grant changes; no data is touched; rollback drops the trigger and function. `tests/db/release-invariant.test.ts` applies it in an in-memory database on top of the real migrations and shows both the gap (the current database publishes the leftover) and the fix. It lives outside `supabase/migrations` because the local live suite compares that folder with the applied history; to apply it, the owner moves both files into `supabase/migrations` and runs `npx supabase migration up --local`. Until then the application checks above are the only guard.
2. **Live metered image provider (Phase 6B only)** — an `ai_usage` image operation (the table CHECK `ai_usage_provider_shape` and the shape test in `ai_usage_reserve`), and a larger generated-file limit on the shared `project-files` bucket once the provider's real output size is known. Not written. Rollback would restore the old CHECK and function after exporting and deleting any `image` ledger rows, and set the previous bucket limits.
3. No `admin_start_generation` function is proposed: the administrator check plus the database guards (verified payment, one active job, state transitions) are sufficient, and an audit event records the administrator.

### Known limits of 6A

- There is **no real image generation**. Everything shown is placeholder output from the test generator.
- Nothing yet prevents an administrator from deliberately releasing mock placeholders: it takes two explicit confirmations and is recorded, but it is allowed.
- Not built: clearing leftover files from the screen, a `/status` entry for image generation, and any automated browser (click-through) test. The pages were checked by fetching them over HTTP as different users (see the test record), not by driving a browser.

## Tests: mocked versus live

The Phase 5 adapter tests are mocked (fake `fetch`, fake database client, in-memory Postgres). The budget guard is additionally tested against the real LOCAL PostgreSQL stack (`tests/live/ai-usage-live.live.test.ts`; no provider is contacted). The Phase 6A mock image path is tested by `tests/unit/image-provider.test.ts`, `generation-prompt.test.ts` and `generation-service.test.ts` (fake client) and against the real local stack by `tests/live/generation-live.live.test.ts` (real guards, storage and release; no network beyond the local stack). No live OpenRouter, Gnani or image-provider test exists. Live smoke tests, when approved, must be separate opt-in scripts (`LIVE_OPENROUTER=1`, `LIVE_GNANI=1`) using synthetic data. The Phase 6A-2 screens' data layer and actions are covered by `generation-read.test.ts`, `generation-actions.test.ts` and `generation-components.test.ts` (markup rendered on the server; no clicks), and the release guard proposal by `tests/db/release-invariant.test.ts`. Results recorded during the Phase 6A-2 task (2026-10-20): `npm test` 37 files / 756 tests; full local live suite 4 files / 103 tests (one earlier run stalled for about ten minutes in an unrelated ledger test and failed, two reruns passed; cause not identified); a 24-check HTTP smoke of the real pages as anonymous, stranger, owner and administrator. No browser click-through test exists or was run.
