# Architectural AI Design — Web Prototype

A concept-design prototype. A customer describes a new building on an empty plot, an interior refresh or a garden. The app turns the answers into an English brief and a server-calculated quote. The customer submits evidence of an offline payment, an administrator verifies it, and only then are concept images generated. They stay private until an administrator releases them.

Outputs are conceptual design ideas, not construction drawings, CAD/BIM models or code-compliant plans.

**Status (2026-10-21): a local prototype with mock AI providers. The local demo path has been run end to end in a browser (development server); the application is not deployed.**
- Phases 1–5 and Phase 6A are complete in the history up to commit `5ecf040`. The release commits after it add the empty-plot SVG layout sketch, the brief's text read-back summary, the administrator pricing screen and this documentation.
- All three journeys passed a local browser run on 2026-10-21 (see "What works today"). That run used the development server, not the production build, and covered neither mobile width nor a real microphone.
- Voice input and concept images are **labelled mocks**. No live AI provider has ever been called. Reference uploads are not built.
- The verified progress ledger, with requirement-by-requirement evidence, is the "Verified Implementation Checkpoint" at the end of `architectural-ai-design-spec/06_IMPLEMENTATION_PLAN.md`.

## Contents

1. [What works today](#what-works-today)
2. [Known limitations](#known-limitations)
3. [Environment checklist](#environment-checklist)
4. [Runbook](#runbook)
5. [Five-minute demo](#five-minute-demo)
6. [Configuration](#configuration)
7. [Project layout](#project-layout)
8. [Notes for developers](#notes-for-developers)
9. [Roadmap](#roadmap)

## What works today

How the "Evidence" column was established:
- **Offline:** the unit and in-memory PostgreSQL tests (`npm test`) were run on the current code: 52 files, 1,126 tests passed on 2026-10-21. The production build passed the same day.
- **Local stack (earlier):** recorded in earlier sessions against a local Supabase stack, or in a local browser. Not re-run since.
- **Browser (2026-10-21):** all three journeys were run end to end in a headless Edge browser against the local development server (`next dev`) and the local Supabase stack, through the real UI, with demo data: create, brief, quote, payment evidence, administrator verification, mock generation, release, and the owner's view of the released results. Isolation and access checks were included: a signed-out visitor, a customer on admin pages, another customer's projects, results before release, and generation before verified payment. No console errors or failed requests were recorded. **Not covered:** the production build in a browser, mobile width, accessibility, a real microphone, receipt-image upload, and a forced generation failure.
- **Not browser-tested:** has never been exercised in a browser.

| Area | What it does | Evidence |
|---|---|---|
| Landing page and three journeys | `/`, `/new/empty-plot`, `/new/interior`, `/new/landscape`; validated multi-step forms; text-only path | Offline; local stack and browser (earlier) |
| Sign-in | Magic link (`/sign-in`, `/auth/callback`); emails arrive in the local inbox | Local stack (earlier) |
| Brief | Built from the answers by a labelled **mock** writer; the customer edits and approves it; missing details listed, never invented; read-back summary shown as text (`/projects/[id]/brief`) | Offline; local stack (earlier); browser-verified 2026-10-21, including the read-back summary |
| Quote | Calculated on the server from `pricing_rules`, itemized, frozen on acceptance; "Pricing not configured" without rules; "Demo rates" label in demo mode (`/projects/[id]/quote`) | Offline; local stack (earlier); browser-verified 2026-10-21 ("Demo rates" label, itemized lines, accepted) |
| Payment evidence | Manual instructions from server configuration; the customer submits a reference and optional receipt image; status is pending, never verified automatically (`/projects/[id]/payment`) | Offline; local stack and browser (earlier); browser-verified 2026-10-21 without a receipt file |
| Admin payment review | `/admin/payments`: 60-second proof links, verify with the full amount or reject with a reason, audited | Offline; local stack and browser (earlier); browser-verified 2026-10-21 (verify only; reject and the proof link were not exercised) |
| Generation and release | `/admin/generation`: an administrator starts generation only after verified payment, reviews and releases. Images come from a **mock** generator marked "MOCK — NOT A DESIGN". Customers see nothing before release (`/projects/[id]/results`) | Offline; browser-verified 2026-10-21 for all three journeys (start mock generation, release with both confirmations, owner's view); local stack (earlier, 103/103 before later fixes) |
| Empty-plot layout sketch | Deterministic SVG drawn from the saved answers on the admin review and customer results pages, under the same release rules as the images. Labelled "Illustrative layout only — not CAD or a construction drawing" | Offline and build; browser-verified 2026-10-21 (two floors for the empty-plot demo project, none for interior and landscape) |
| Pricing settings | `/admin/pricing`: an administrator publishes a new version of a rate, minimum charge, included quantity, currency or tax rate, in force immediately; history kept; audited | Offline and build; browser-verified 2026-10-21 as a read-only view (17 demo rules, nothing published); **publishing was not exercised against real Supabase** |
| Voice input | Off by default. With `GNANI_VOICE_ENABLED=mock`: consent, browser recording or WAV upload, then a fixed **mock** placeholder transcript that cannot be saved as the description | Offline; headless browser with a fake microphone (earlier) |
| `/status` and `GET /api/health` | Which optional services have settings present: names and states only, never values; "configured" never means "verified" | Offline |

## Known limitations

These come from the code and the original requirements (`architectural-ai-design-spec/01_PRD.md`, PR-001 to PR-035).

**Voice**
- **Mock only.** Speech-to-text never calls Gnani. The mock ignores the audio and returns a fixed placeholder labelled `[MOCK TRANSCRIPT — no speech service was used]`. The server refuses to save it as a description or to build a brief from it.
- **Live speech-to-text is switched off in code.** `LIVE_STT_WIRED = false` (`src/lib/journeys/voice.ts`), so even complete live settings show voice as unavailable.
- **Live speech-to-text is blocked** on facts about the Gnani account: host and authentication, credit rates, supported languages and limits. See `docs/PROVIDERS.md`.
- **Mock transcripts never set the project language**, which stays `en`. "Tanglish" is a demo-only label.

**Read-back (PR-009)**
- The read-back summary is shown as **text** on the brief page, with a note that listening is not available.
- Spoken read-back (Gnani text-to-speech) is not built. It needs the same account facts and the owner's approval.

**Brief writer**
- The brief comes from a labelled mock template.
- The OpenRouter adapter exists and is tested only with fake responses. Turning it on (`PROVIDER_MODE=live`) needs a model choice and a privacy notice for sending customer answers to a third party: an owner decision, not made.

**Concept images**
- Only the mock generator exists: a deterministic placeholder PNG with no AI model, no network and no cost.
- Live image generation (Phase 6B) is blocked. It needs a provider, model, price and spending cap, a migration for usage metering and the storage limit, and the privacy decision.
- Two items are open before then:
  - a database rule so that a request that was cleared as stale cannot add files;
  - the release guard proposed in `supabase/proposed/` (not applied).

**Reference uploads (PR-010)**
- **Not built.** Forms show "Uploads not configured yet".
- Blocked on an owner decision: which file types and sizes to allow, and how long uploads are kept.
- The interior and landscape journeys therefore work without photos.

**Layout sketch**
- An illustrative diagram drawn by code. It shows:
  - the plot outline in the customer's proportions;
  - the plot dimensions and unit as entered;
  - the facing direction;
  - one numbered block per requested room.
- Block sizes and positions follow a fixed rule. No room sizes are shown or implied. No setbacks, building rules or approvals are applied.
- Plots more elongated than 1:3 are drawn "Not to scale".
- The sketch is not CAD, not a construction drawing and not stored; it is drawn again each time it is shown.

**Pricing (PR-024)**
- Publishing a rate makes it apply to **new** quotes immediately. Accepted quotes keep their frozen prices.
- Whether quotes say "Demo rates" is decided separately, by the `pricing_mode` setting, which the screen does not change. Rates published while demo mode is on are still labelled demo. Turning demo mode off (real rates in effect) is the owner's decision.
- Not on the screen (owner decisions):
  - discounts (always zero today);
  - payment instructions (kept in server configuration, `PAYMENT_*`);
  - scheduling a price for a future date.
- The demo rates in `supabase/demo/pricing_rules.demo.sql` are unverified placeholders, not commercial prices.

**Payments**
- Manual and offline only. The app never moves money and never treats a receipt as proof of payment: an administrator verifies against the receiving account.
- No automated gateway (out of scope).

**Privacy and retention**
- Voice consent is asked for each recording but not stored.
- Audio is never stored.
- No retention or deletion periods have been decided, for transcripts, payment proofs or generated files. No privacy notice exists for live providers.

**Verification gaps**
- **Browser coverage is partial.** The 2026-10-21 run covered the three journeys on the development server. Not covered: the production build in a browser, mobile width, a real microphone, receipt-image upload, the payment-reject path, publishing a price, and a forced generation failure.
- **No mobile-width (360 px) or accessibility check recorded.**
- **The local live Supabase suites** last passed before the Phase 6A closure fixes and the transcript-column migration. They delete local pricing data and disable a guard trigger during setup, so they must not be run without an isolated plan.
- **No rollback rehearsed on real PostgreSQL.**

**Deployment**
- None. No hosting configuration, no hosted Supabase project, no Git remote, no monitoring.

**Process limits**
- The voice rate limit is per server process. The mock transcript signing key is per process unless `VOICE_TRANSCRIPT_SECRET` is set.

## Environment checklist

No branching strategy or environment mapping is documented: there is one local branch, `main`, and no remote.

| Environment | What exists | What is missing or unverified | Safe to use now? |
|---|---|---|---|
| **Local development** | Code and dependencies; a git-ignored `.env.local` (exists; holds local Supabase settings according to earlier records; never commit or print it); a local Supabase stack in Docker, with all 8 migrations applied locally according to earlier records. Its current running state is not checked here. | Re-checking the local stack, demo data and an administrator account before a demo. Live provider settings are intentionally absent. | Yes for offline work (`npm test`, typecheck, lint, build). Starting Docker or Supabase, applying migrations or loading demo data needs the owner's approval in this project. |
| **QA / testing** | No separate QA environment. The offline suite (`npm test`: unit tests plus in-process PostgreSQL, network blocked) is the safe test layer. The live suites (`tests/live/`, `LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts`) run against the local stack only. | An isolated plan for the live suites, whose setup deletes local `pricing_rules` and disables a guard trigger. Browser tests are not in the repository. | Offline suite: yes. Live suites: no, not without an approved isolated plan. |
| **Staging** | Nothing. | Everything: hosting, a Supabase project, migrations, secrets, a URL. | No. It does not exist. |
| **Production** | Nothing. | Everything above, plus monitoring, backups, a privacy notice, retention rules, real prices and payment details, and live-provider verification. | No. It does not exist. |

A passing offline build does **not** mean providers are wired, the database is configured, secrets are set or anything is deployed. Those are separate checks.

## Runbook

**What was checked when.**
- **Run on the current code on 2026-10-21:** `npm install` was not re-run; the four check commands below were.
- **Last recorded working in earlier sessions:** the Supabase and app start-up commands (`supabase/README.md`; the earlier session notes). They were **not** re-run while writing this.

### 1. Prerequisites

- Node.js 22.12 or later (this machine: Node 24.16.0, npm 11.13.0). Next.js 16.4.2, React 19.3, TypeScript 5, Tailwind CSS 4.
- For a local database: Docker Desktop and the Supabase CLI (`npx supabase`).
- No accounts or API keys are needed for offline work or the mock demo.

### 2. Install and run the offline checks

```bash
npm install
npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npm test              # vitest run: unit tests plus in-process PostgreSQL; network blocked; no Supabase account
npm run build         # production build; set NEXT_TELEMETRY_DISABLED=1 to skip Next.js telemetry
```

`npm test` also picks up `tests/db/release-invariant.test.ts`, an intentionally uncommitted test of the proposed release guard. To test only the committed tree, run `npx vitest run --exclude tests/db/release-invariant.test.ts`.

### 3. Local database (needs Docker and the owner's approval to start)

```bash
npx supabase start -x studio,realtime,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta
npx supabase status -o env      # copy the local URL and keys into .env.local
```

- **Applying migrations.** On a fresh stack, start-up applies every file in `supabase/migrations/` (8 today; `supabase/README.md` still says 5, written in Phase 2). An existing local database was brought forward with `npx supabase migration up --local`. Never run `supabase db reset` or anything against a hosted project without approval.
- **`.env.local` format.** Keep it to plain `KEY=value` lines: no comments and no byte-order mark, because the Supabase CLI reads it too.
- **Variables the app needs for the local stack:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL` (for example `http://localhost:3000`).
- **The service role key is required.** Saving the description step, creating a brief, calculating a quote and generation all use it. Without it those actions fail safely. The administrator pricing screen and the payment and release decisions use the administrator's own session instead.
- **Making someone an administrator.** Add their row by SQL: `insert into public.admin_users (user_id) values ('<auth user uuid>');`. `ADMIN_EMAILS` is not read by the code and grants nothing.
- **Demo prices.** Load `supabase/demo/pricing_rules.demo.sql` by hand. It also sets `pricing_mode` to demo, so quotes say "Demo rates". Never load it into production.
- **Payment instructions** (display only): `PAYMENT_MODE=manual`, `PAYMENT_UPI_ID` and/or `PAYMENT_INSTRUCTIONS`, optionally `PAYMENT_ACCOUNT_NAME`, and `PAYMENT_CURRENCY` matching the quote currency. Values containing the word "demo" are labelled as demo details.
- **Stopping.** `npx supabase stop` keeps the data; adding `--no-backup` discards it.

### 4. Start the app

```bash
npm run build && npx next start -p 3000    # how earlier browser checks ran; restart after changing .env.local
# or: npm run dev
```

- **Sign-in.** Use one host name throughout a sign-in, either `localhost` or `127.0.0.1`. Magic-link emails appear at `http://127.0.0.1:54324`.
- **Configuration check.** `/status` and `/api/health` show which settings are present.
- **Mock voice.** Set `GNANI_VOICE_ENABLED=mock`. Leave `PROVIDER_MODE` unset (mock).

### 5. Safety rules

- Never print, paste or commit `.env.local` or keys, and never put a secret in a `NEXT_PUBLIC_*` variable.
- Do not set `PROVIDER_MODE=live` or call Gnani, OpenRouter or any image provider without the owner's explicit approval for that specific test.
- Do not run the live suites, migrations, rollbacks or SQL against anything without approval. Never against a hosted project.
- Protected, untracked files: `handoff.md`, `supabase/proposed/`, `tests/db/release-invariant.test.ts`. Do not edit or commit them.

## Five-minute demo

See [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md). It follows `architectural-ai-design-spec/09_DEMO_SCRIPT.md` and marks every step as verified, mock-only or still needing a browser check. Steps that cannot be shown truthfully today have labelled fallbacks.

## Configuration

Copy `.env.example` to `.env.local` and fill in values only when a feature needs them. All values are blank by default, and `.env.local` is git-ignored.

Where each variable is documented:
- `architectural-ai-design-spec/ENVIRONMENT_VARIABLES.md`: every variable;
- `.env.example`: comments on current behaviour;
- `docs/PROVIDERS.md`: provider and voice settings.

Validated by `src/lib/env/schema.ts` but **not read by the app today**:
- `APP_BASE_URL`
- `ADMIN_EMAILS`
- `SUPABASE_DB_URL`
- `SUPABASE_STORAGE_BUCKET`
- `OPENROUTER_IMAGE_MODEL`
- `GNANI_STT_MODEL`
- `LOG_LEVEL`
- `RATE_LIMIT_MAX_REQUESTS`
- `RATE_LIMIT_WINDOW_SECONDS`

Never put a secret in a `NEXT_PUBLIC_*` variable: those are sent to the browser.

## Project layout

```
CLAUDE.md                Project instructions for Claude Code (section 19: current state and standing rules)
AGENTS.md                Written by Next.js: agents read its bundled docs first
.env.example             Blank environment template (names only)
docs/PROVIDERS.md        Provider verification record (OpenRouter, Gnani, voice, images)
docs/DEMO_SCRIPT.md      Five-minute presenter script for the current local prototype
src/app/                 Pages, Server Actions and API routes (customer under /projects, admin under /admin)
src/components/          UI components (journey, payments, generation, pricing)
src/lib/journeys/        Steps, validation, brief, quote, project service, voice mode
src/lib/payments/        Payment evidence and display configuration
src/lib/generation/      Mock image generation, release, read layers, SVG layout sketch
src/lib/pricing/         Administrator pricing settings
src/lib/providers/       Provider interfaces, budget guard, OpenRouter and Gnani adapters, mocks
src/lib/voice/           Recorder, provenance tokens, rate limit, voice wording
src/lib/env/             Environment schema and validation
src/lib/integrations/    Integration status (presence only, never values)
src/lib/supabase/        Supabase clients (user session; server-only service role) and origin policy
src/lib/auth/, admin/    Session and administrator guards
src/lib/db/              Database vocabulary (statuses, transitions)
src/lib/storage/         Private-bucket path helpers
src/proxy.ts             Refreshes the sign-in session cookies
supabase/                Migrations, rollbacks, demo pricing and database documentation
tests/unit/              Unit tests (network blocked)
tests/db/                Database tests (in-process PostgreSQL)
tests/live/              Local-stack suites (opt-in; destructive setup)
architectural-ai-design-spec/                Product and technical specification (06: plan plus progress ledger)
architectural-ai-skill-integrated-prompts/   Phase prompts and build orchestration
```

## Notes for developers

- This project uses Next.js 16 with Cache Components enabled. Code that reads environment values or the session at request time calls `await connection()` first and sits behind `<Suspense>`. Do not use `dynamic = "force-dynamic"`.
- Error pages receive `retry`, not the older `reset`.
- System fonts only. No external font or asset requests are made.
- `AGENTS.md` is written by Next.js; it tells coding agents to read the bundled docs in `node_modules/next/dist/docs/` before writing Next.js code.
- Rates, taxes and currency symbols must never be written into UI code (a test enforces this). Prices come only from `pricing_rules`.

## Roadmap

Phases follow `architectural-ai-skill-integrated-prompts/`. Each phase is approved by the project owner before the next starts.

1. Foundation — done
2. Database, sign-in and private storage — done
3. Customer journeys and quote — done
4. Payment evidence and admin review — done
5. AI text and voice — foundation done; mock voice; text read-back; live providers blocked
6. Image generation and controlled release:
   - mock generation and release — done (committed);
   - SVG layout sketch and pricing screen — done;
   - live image generation (6B) — blocked
7. End-to-end QA and demo handoff — documentation in progress; browser and service verification not started
