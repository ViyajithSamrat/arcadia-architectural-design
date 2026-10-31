# Real integration completion report (second finalization pass)

Date: 2026-10-22. Base commit: `ec18ac9` (also `origin/main`). Everything below is an uncommitted working-tree change; nothing was staged, committed, pushed or deployed. Protected paths were not modified (hashes in the last section).

## Bottom line

- **No real provider has been called.** No OpenRouter or Gnani credential exists on this machine (variable names checked, never values). All four provider integrations are therefore **UNVERIFIED / NOT TESTED against the real services**. Fake-network tests only prove the code follows the documentation read on 2026-10-22.
- **Verified on the local stack in this pass:** migration 9, reference uploads and private storage (real Supabase Storage, and a real browser on the production build), pricing form behaviour in a browser, the payment/generation/release gates (service level and browser), the usage ledger, timeouts and cleanup (unit level), and real PostgreSQL concurrency for the proposed late-write rule.
- **Owner decisions still hold back two things:** the late-write database rule is prepared and tested but **not adopted** (it conflicts with the protected `release-invariant` test), and nothing live can run until credentials, models and prices are supplied.

## Four live-provider statuses (kept separate)

| Provider | Status | Why | What is verified |
|---|---|---|---|
| Gnani speech-to-text | **UNVERIFIED, NOT TESTED** | no key, endpoint, rates | Docs read 2026-10-22 match the adapter (`POST https://api.vachana.ai/stt/v3`, header `X-API-Key-ID`, multipart `audio_file` + `language_code`, response `success`/`request_id`/`transcript`/`model`); `ta-IN` and `en-IN` are listed as supported. 30 fake-network tests |
| Gnani text-to-speech | **UNVERIFIED, NOT TESTED** | same | Docs match (`POST /api/v1/tts/inference`, JSON, `timbre-v2.5`/`timbre-v3.0`, `en-IN` listed, `speed` 0.85–1.15, `sample_rate` 24000 allowed, WAV response). Voices are model-specific; the owner must pick one from the voice catalog. 61 fake-network tests, plus browser checks of the control against a stubbed response |
| OpenRouter structured text | **UNVERIFIED, NOT TESTED** | no key/model | Fake-network tests; smoke harness has a preflight (below) |
| OpenRouter image generation | **UNVERIFIED, NOT TESTED** | no key/model | 65 fake-network tests. Compatibility of a chosen model with `POST /images` can only be confirmed by a first paid call; the preflight checks the model lists image output and a usable price |

Credit unit (Gnani): **not documented.** The Gnani docs say only that a 403 can mean "check ... available credits"; no page gives a price, a credit unit or a rate limit. The 5,000-credit ceiling stays enforced in code and in the database function, but what one credit buys must come from the owner's Gnani account. Rates are owner-supplied settings; none is assumed.

## Checks run (2026-10-22, final tree)

| Command | Result |
|---|---|
| `npx tsc --noEmit --incremental false` | exit 0 |
| `npx eslint` | exit 0, no warnings |
| `npx vitest run` (unit + in-process PostgreSQL, network blocked) | 64 files, **1,427 tests passed**, 0 failed |
| `NEXT_TELEMETRY_DISABLED=1 npm run build` | exit 0 |
| live local: `references-storage` | 11 passed |
| live local: `payments-live` + `generation-live` | 45 passed (includes the new leftover-clearing test) |
| live local: `ai-usage-live` | 16 passed |
| live local: `supabase-live` (now non-destructive) | 43 passed, 1 skipped (the "pricing not configured" case runs only when the table is empty; it is covered in memory) |
| live local: `late-asset-writes` (proposed rule applied temporarily, then restored) | 4 passed |
| `LIVE_PROVIDER_SMOKE=1 npx vitest run --config vitest.smoke.config.mts` | 4 skipped (no credentials) |
| Browser (headless Edge, production build, local Supabase, mock providers) `finalize.mjs` | 36 PASS, 1 CHECK, 0 FAIL |

## Issues investigated: root cause, fix, regression test

| # | Issue | Root cause | Fix | Regression test | Result |
|---|---|---|---|---|---|
| 1 | Late write by a request cleared as stale | Lifecycle: the provider call can outlive the 10-minute stale rule (only the provider call has a timeout); the stale clearing marks the job FAILED; the delayed request later uploads files and inserts `design_assets` rows, and the database guard checks only the job's project and the verified payment | Database rule prepared in `supabase/proposed/20261022000200_assets_only_for_running_jobs.sql` (+ `.down.sql`): the job row is read `FOR SHARE` and the insert is refused unless the job is RUNNING. The lock makes the stale clearing wait for an in-flight insert and makes a later insert fail. **Not adopted**, see below | `tests/db/late-asset-writes.test.ts` (8, in-memory); `tests/live/late-asset-writes.live.test.ts` (4, real concurrency on local PostgreSQL: late write refused, clearing waits for an in-flight insert for >2 s, insert after the clearing refused, two concurrent inserts for a running job both succeed). The local function was restored afterwards (verified) | proven, **not adopted** |
| 2 | Storage/database calls could hang | Only provider calls had time limits | `src/lib/supabase/timeout.ts` gives every server-side Supabase request (PostgREST, Auth, Storage) a time limit, wired into the service and server clients: 15 s, 60 s for file transfers. Never retries | `tests/unit/supabase-timeout.test.ts` (6) | passes |
| 3 | Cleanup could lose track of files | `abort()` deleted rows first, then objects; a failed object removal left an untracked file | Objects are removed first and rows only after that succeeds (`removeJobFiles`), so a file that cannot be removed stays listed as a leftover; used by failure cleanup and by stale clearing | `tests/unit/generation-recovery.test.ts` | passes |
| 4 | Leftover files could not be removed from the screen | No recovery path | `removeLeftoverFiles` (administrator only, audit event first, never touches a succeeded job's files, refuses during a running job and after release, also removes unreferenced objects) with an action and a confirmation form on the admin generation page | 14 unit tests; live test on the real stack in `generation-live` | passes |
| 5 | `supabase-live` deleted pricing rules in its setup | Re-runnability shortcut | Deletion removed; demo rates load only into an empty table; the "not configured" case is skipped when rules exist; the "no migration seeds prices" check reads the migration files | ran the suite: 43 passed; pricing table checksum identical before and after | passes |
| 6 | Pricing unit rejected `block of 500 sq ft` etc. (pass 1) | Regex allowed letters and spaces only | Allow digits, `.`, `/`, `-` after a letter | 11 cases in `pricing-admin.test.ts` | passes |
| 7 | Confirmation tick stayed ticked (pass 1) | Form never reset | `form.reset()` on success | source guard test **and now a browser run**: a refused publish keeps the form and shows the error; a successful publish clears the tick | passes in browser |
| 8 | Silent live recording returned a signed empty transcript (pass 1) | no empty check | 422 `NO_SPEECH` | `voice-live-stt.test.ts` | passes |
| 9 | Image smoke test could overspend | No guard | `tests/provider-smoke/openrouter-guard.ts`: needs a key with its own credit limit of at most US$5, a model that lists the right output and a usable price (worst case per request at most US$1), and re-reads real spend from the key's usage counter before each paid request | `tests/unit/openrouter-smoke-guard.test.ts` (19) | passes |
| 10 | Currency of a priced project type cannot be changed | By design (quotes must not mix currencies) | Not changed; owner decision | existing tests | owner decision |
| 11 | Small floor-plan blocks drop their label | By design; the room list names every room | Not changed | existing tests | accepted |

**Why the late-write rule is not in `supabase/migrations`.** The protected `tests/db/release-invariant.test.ts` builds a leftover by inserting an asset for a job that is *already FAILED* (and `generation-live`'s own leftover case does the same). That is exactly the write the rule forbids, so adding the rule to the migrations would make a protected test fail, and I did not change protected files. **Smallest safe resolution (owner's decision):** in `leftoverScenario`, insert the leftover asset while the job is still `RUNNING` and mark the job `FAILED` afterwards; the final state is identical and it models a failed cleanup correctly. After that, move the proposed file into `supabase/migrations` with a new timestamp and run the full suite. The rule was not applied to any database beyond the temporary local test.

## Migration status

- Migration 9 (`20261022000100_ai_usage_images.sql`): **applied to the local database only**; verified (constraints, rolled-back reserve test, privileges, 16-test ledger suite). Not applied anywhere hosted.
- Proposed `20261022000200_assets_only_for_running_jobs` and the earlier `20261020000100_release_only_succeeded_jobs`: **not applied**, not in `supabase/migrations`.

## Browser verification (production build, local Supabase, mock providers, 2026-10-22)

Run with headless Edge through Playwright-core (already on the machine; nothing installed). The production server ran with FAKE Gnani settings so the read-back control is offered; the browser intercepted the read-back request, so **Gnani was never called**.

- **Uploads (interior and landscape):** uploader shown (no "not configured" notice); a text file posing as a PNG, a PDF, a 5 MB+ file and an empty file are each refused with a plain message and create no record; a valid PNG is stored (1 row, 1 object), its thumbnail loads through a signed link on a private bucket; removing it deletes the row and the object; six photos are allowed and the seventh is blocked with a reason.
- **Read-back:** the Listen control stays disabled until consent is ticked; the browser sends only `{"consent":true}`; a stubbed provider failure shows a plain error and the text stays; a stubbed WAV becomes a playable audio element (1 s); a non-audio answer is treated as a failure; the real route refuses a request without consent (400) before any provider call. **Not verified:** real Gnani audio, real voices, and the real route's provider path.
- **Pricing:** a refused publish (different currency) shows "Nothing was saved", keeps the tick and writes nothing (rows unchanged); a successful publish adds exactly one version (same values) and clears the tick. Side effect: the local pricing table went from 17 to 18 rows (a second version of one demo rate, same price).
- **Gates:** a customer is denied the admin generation and pricing pages; results of an unreleased project show no images; the administrator sees no start button before verified payment; the project state is unchanged. (The full customer to payment to verification to release path was last driven in a browser on 2026-10-21 and re-verified at service level by `payments-live` and `generation-live` today.)
- One CHECK: the brief text does not mention the number of uploaded photos (they are recorded as ids, not described in prose); not a defect.
- Console/HTTP noise in the run was only the expected 422/400/502 answers to refused uploads and stubbed errors.
- Not tested in a browser: a real microphone, Safari, a phone, a 360 px layout.

## Provider readiness and cost controls

- Documentation re-read 2026-10-22: Gnani endpoints resolved (the two path "variants" were documentation page paths; the API paths are `/stt/v3` and `/api/v1/tts/inference`), `X-API-Key-ID` authentication, language lists, 60 s STT limit (one page says 30 s), no credit documentation. OpenRouter key information is available at `GET /api/v1/key` (fields `limit`, `limit_remaining`, `usage`), which the guard uses.
- OpenRouter's public model list has many image-output models; price is per image token or per image. None was chosen or priced against an account.
- Gnani 5,000-credit ceiling retained in code and in the database function. No language support or credit rate is assumed: both are owner-supplied settings (`GNANI_LANGUAGES`, `GNANI_CREDITS_PER_*`).
- No silent mock fallback: an incomplete live configuration reports "unavailable" (tests: `voice-mode`, `integration-status`, `openrouter-image`, `generation-service`).

## Remaining credentials and owner decisions

| Item | Next action |
|---|---|
| OpenRouter | Create a key with a US$5 credit limit; set `OPENROUTER_API_KEY`, `OPENROUTER_TEXT_MODEL`, `OPENROUTER_IMAGE_MODEL`, `PROVIDER_MODE=live` |
| Gnani | Set `GNANI_API_KEY`, `GNANI_BASE_URL=https://api.vachana.ai`, `GNANI_STT_ENDPOINT=/stt/v3`, `GNANI_TTS_ENDPOINT=/api/v1/tts/inference`, `GNANI_TTS_MODEL` (`timbre-v2.5` or `timbre-v3.0`), `GNANI_TTS_VOICE` (valid for that model), `GNANI_LANGUAGES` incl. `en-IN`, credit rates from the Gnani account, budget (at most 5000), `VOICE_TRANSCRIPT_SECRET`, `GNANI_VOICE_ENABLED=true` |
| First real run | Apply nothing else; run `LIVE_PROVIDER_SMOKE=1 npm run smoke:providers` (one call each). On Git Bash set `MSYS_NO_PATHCONV=1` when passing path values through environment variables |
| Late-write rule | Owner decides on the two-line change to the protected test, then adopt the proposed migration |
| Privacy and retention | Owner decisions in `docs/PRIVACY_RETENTION_CHECKLIST.md` (draft; no approved notice exists) |
| Hosted Supabase and deployment | Owner decision; none exists |

## Reproduce

```
npx tsc --noEmit --incremental false
npx eslint
npx vitest run
NEXT_TELEMETRY_DISABLED=1 npm run build
# local Supabase running (Docker); all non-destructive, @example.test data only:
LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts tests/live/references-storage.live.test.ts
LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts tests/live/payments-live.live.test.ts tests/live/generation-live.live.test.ts tests/live/ai-usage-live.live.test.ts tests/live/supabase-live.live.test.ts
LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts tests/live/late-asset-writes.live.test.ts   # applies the proposed rule temporarily, restores it
# real providers (spends credits; owner approval and credentials required):
LIVE_PROVIDER_SMOKE=1 npm run smoke:providers
```

The browser script (`finalize.mjs`) lives in the session scratchpad, not in the repository; its steps are the bullet list above.

## Files changed in this pass

Source: `src/lib/supabase/timeout.ts` (new), `src/lib/supabase/service.ts`, `src/lib/supabase/server.ts`, `src/lib/generation/service.ts` (cleanup order, `removeLeftoverFiles`), `src/app/(app)/admin/generation/actions.ts`, `src/app/(app)/admin/generation/[projectId]/page.tsx`, `src/components/generation/controls.tsx`.
Database (proposed, unapplied): `supabase/proposed/20261022000200_assets_only_for_running_jobs.sql` and `.down.sql`.
Tests: `tests/unit/supabase-timeout.test.ts`, `generation-recovery.test.ts`, `openrouter-smoke-guard.test.ts`, `tests/unit/support/fake-supabase.ts` (list/failRemove/failList), `tests/db/late-asset-writes.test.ts`, `tests/live/late-asset-writes.live.test.ts`, `tests/live/supabase-live.live.test.ts` (non-destructive), `tests/live/generation-live.live.test.ts` (leftover-clearing case), `tests/provider-smoke/openrouter-guard.ts`, `tests/provider-smoke/providers.smoke.test.ts`.
Docs: `docs/PRIVACY_RETENTION_CHECKLIST.md` (new), this report, `docs/IMPLEMENTATION_REQUIREMENTS_AUDIT.md`, `docs/PROVIDERS.md`, `README.md`, `.env.example`, `CLAUDE.md`.

## Known remaining gaps

- Reference-upload/pricing/read-back UI: browser-verified on the production build with mock providers only; no real microphone, no mobile width, no accessibility audit.
- An unreferenced uploaded file whose cleanup failed is private and findable only by the administrator's leftover sweep for *generated* files; the equivalent for customer reference uploads (`references/` objects without a row) has no sweep.
- Timeouts stop waiting; they do not undo work the server may still finish. Write paths are ordered so that this leaves nothing misleading, but a late write is still possible until the proposed database rule is adopted.
- No retention, deletion or export mechanism exists (see the privacy checklist).
