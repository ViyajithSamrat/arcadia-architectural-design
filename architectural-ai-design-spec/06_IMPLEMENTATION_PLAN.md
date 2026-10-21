# 6. IMPLEMENTATION PLAN --- Claude Code Execution Roadmap

## 6.1 Execution protocol for Claude Code

Claude Code should work in small, reviewable phases. At the start of
every phase:

1.  Inspect the existing repository, package manager, scripts, routes,
    styling system, tests, and uncommitted changes.
2.  Read this specification and identify relevant acceptance criteria.
3.  Propose the smallest implementation slice before editing.
4.  Do not overwrite unrelated files or restructure a sound existing
    architecture without justification.
5.  Keep provider credentials server-side.
6.  Run relevant lint, type-check, unit/integration tests, and build
    checks after each meaningful change.
7.  Report files changed, commands run, results, known gaps, and the
    next smallest step.
8.  Never claim a provider is live unless a real credential-backed smoke
    test passed. Mark mocks explicitly.
9.  Do not move to a dependent phase while a critical security gate from
    the prior phase is broken.
10. Keep commits/diffs logically scoped where Git is available.

## 6.2 Four-day delivery schedule

  -----------------------------------------------------------------------
  Day                     Focus                   Concrete exit criteria
  ----------------------- ----------------------- -----------------------
  Day 1 --- Foundation    Confirm                 App runs; responsive
  and UI                  scope/credentials; app  landing/forms;
                          shell; design system;   schema/storage
                          landing page; three     configured; health
                          journeys/forms;         route works; provider
                          Supabase                smoke tests attempted;
                          schema/storage; mock    mock fallback labelled
                          adapters

  Day 2 --- Voice and     Browser recording;      At least one live voice
  brief                   Gnani STT/TTS adapters; path for each agreed
                          transcript editing;     priority language, or
                          structured brief;       explicit fallback;
                          clarification and       editable transcript;
                          approval                valid brief; missing
                                                  values flagged;
                                                  approval gate works

  Day 3 --- Generation,   OpenRouter image        All three flows produce
  quote, payment          adapter; deterministic  live or labelled mock
  submission              SVG plan; gallery;      demo assets; quote
                          pricing rules; quote;   itemized; payment
                          payment                 submission pending;
                          instructions/proof;     outputs remain private
                          first admin queue

  Day 4 --- Verification, Admin verify/reject;    Unpaid
  gating, QA, deploy      audit trail;            generation/release
                          server-side release     blocked even by direct
                          gate; negative tests;   API; verified project
                          deployment; runbook and can generate; admin
                          demo                    release unlocks owner
                                                  access; failure paths
                                                  smoke-tested
  -----------------------------------------------------------------------

The source PDF assumes a four-day run beginning Monday, 12 October 2026,
through Thursday, 15 October 2026, but dates should be adjusted to the
actual kickoff. It assumes roughly eight working hours per day. The
timeline is aggressive and depends on Day-1 credentials and limited
scope.

## 6.3 Phase 0 --- Repository inspection, configuration, vertical-slice plan

**Time box:** First 1--2 hours of Day 1.

### Tasks

-   Inspect current repository and uncommitted changes.
-   Confirm runtime, package manager, scripts, current framework, route
    layout, styling, and tests.
-   Decide whether to retain existing architecture or use Next.js App
    Router + TypeScript.
-   Create clean environment-variable loading and `.env.example` with
    placeholders only.
-   Add typed configuration, health/readiness route, structured server
    logs, provider interfaces, and explicit mock adapters.
-   Write local run/setup/smoke-test instructions.
-   Run direct provider smoke tests for credentials/endpoints without
    wiring the entire UI.

### Acceptance

-   App starts.
-   Health route responds without exposing secrets.
-   Lint/type-check passes.
-   Existing unrelated work remains untouched.
-   Provider questions and unavailable credentials are documented.

## 6.4 Phase 1 --- Landing page and three input journeys

**Time box:** Remaining Day 1.

### Tasks

-   Implement premium, responsive landing page and three project cards.
-   Build multi-step forms for empty plot, interior, and landscaping.
-   Add reusable progress indicator, validation, upload entry points,
    text input, and voice entry point.
-   Add visible concept-only disclaimer.
-   Use realistic demo content, not lorem ipsum.
-   Do not invent pricing rates.
-   Voice entry may be disabled/marked as not yet available until Phase
    2.
-   Configure Supabase schema and private buckets; create initial seed
    data labelled demo-only.

### Acceptance

-   Three project types are distinct and usable.
-   All required fields are represented.
-   Forms work at mobile and desktop widths.
-   Text-only path can continue.
-   Upload limits and consent/voice placeholders are clear.
-   Lint/type-check passes.

## 6.5 Phase 2 --- Gnani voice path: STT, transcript review, TTS

**Time box:** First half of Day 2.

### Tasks

-   Implement `MediaRecorder` with microphone permission messaging and
    stop/cancel/re-record controls.
-   Upload audio to a protected server route.
-   Implement server-only Gnani adapter using the actual supplied
    endpoint/auth protocol.
-   Configure supported languages/voices from server configuration.
-   Display transcript; allow corrections; store original and corrected
    versions separately.
-   Add TTS read-back for summary/clarification; keep visible text
    fallback.
-   Delete raw audio after transcription unless retention is explicitly
    configured and consented.
-   Test missing API key, malformed response, unsupported language,
    timeout, and transcription failure.

### Acceptance

-   Voice works for the agreed priority language(s) or the text fallback
    is clear and usable.
-   No Gnani key appears in client code.
-   User can correct transcription before normalization.
-   Unsupported TTS leaves the text visible.
-   Retention behavior is documented and tested.

## 6.6 Phase 3 --- Requirement normalization and approved English brief

**Time box:** Second half of Day 2.

### Tasks

-   Implement `BriefProvider` through OpenRouter text generation.
-   Define Zod schemas for `EMPTY_PLOT`, `INTERIOR`, and `LANDSCAPE`.
-   Merge corrected transcript and validated form fields.
-   Required output shape:
    -   `projectType`
    -   `sourceLanguage`
    -   `requirements`
    -   `dimensionsAndUnits`
    -   `roomOrZoneList`
    -   `stylePreferences`
    -   `budgetBand`
    -   `referenceAssetIds`
    -   `missingRequiredFields`
    -   `assumptions`
    -   `englishBrief`
    -   `customerReadbackText`
    -   `imagePrompts`
-   Never accept model-generated prices or payment status.
-   Add a review screen for transcript, structured summary, assumptions,
    missing details, and editable English brief.
-   Disable quote acceptance/generation until required values are
    resolved and customer approval is recorded.
-   Store prompt version and model ID in metadata.

### Acceptance

-   Invalid model JSON is rejected.
-   Missing data is represented as null/listed, not fabricated.
-   Must-preserve features are carried forward.
-   At least three fixture tests exist, one for each project type.
-   Approval gate is enforced server-side.

## 6.7 Phase 4 --- SVG plan renderer and AI concept generation

**Time box:** First half of Day 3.

### Tasks

-   Implement provider-agnostic OpenRouter Image API adapter.
-   Verify model support for image size, aspect ratio, and
    reference-image input.
-   Keep image model and fallback configurable.
-   For empty plot, generate deterministic SVG from validated structured
    room/layout data.
-   Draw room rectangles/partitions, labels, and approximate dimension
    labels only when justified.
-   Add watermark/legend: "Illustrative layout only---not CAD or a
    construction drawing."
-   For interior/landscape, send selected references only when
    provider/model supports them.
-   Store outputs in private storage and persist model/prompt/job
    metadata.
-   Build results gallery with AI Concept label, failure state, and
    retry action.
-   Add image count/resolution/file-size/timeout caps, cost logging, and
    conservative retry.

### Acceptance

-   Empty plot plan labels are generated by SVG code, not the image
    model.
-   Generated images are private before release.
-   Generation endpoint rejects unpaid projects.
-   Provider failure, empty result, unsupported reference input, and
    unpaid denial are tested.
-   Mocks are labelled.

## 6.8 Phase 5 --- Quote calculator, offline payment, admin operations

**Time box:** Second half of Day 3 into Day 4 morning.

### Tasks

-   Store configurable project-type pricing rules and official payment
    instructions in protected configuration/database records.
-   Implement server-side itemized quote engine using project type,
    area/room/zone counts, included quantities, selected views, add-ons,
    minimum charge, discount, and tax.
-   Use decimal-safe arithmetic.
-   Freeze accepted quote snapshot and pricing version.
-   Implement customer payment page with official UPI QR/ID or bank
    instructions, accepted quote total, UTR/reference, transfer date,
    amount, method, and optional proof.
-   Store proof in a private bucket.
-   On submission set payment to pending/proof-submitted only.
-   Build admin-only payment queue; signed URL proof preview;
    verify/reject with reason; audit every mutation.
-   Check admin role on every server mutation.
-   Record confirmed amount, actor, timestamp, and audit note.

### Acceptance

-   Client cannot set final amount or payment status.
-   Payment submission never auto-verifies.
-   Unverified payment cannot generate or release.
-   Admin verification/rejection is auditable.
-   Quote remains unchanged if pricing rules change after acceptance.
-   No sensitive banking credentials are requested.

## 6.9 Phase 6 --- Release gate, UX polish, QA, deployment

**Time box:** Remaining Day 4.

### Tasks

-   Implement central server-enforced state machine and reject invalid
    transitions.
-   Add role/ownership checks to generation, asset access, payment
    mutation, and release routes.
-   Issue signed URLs only for owner access to `RELEASED` projects or
    authorized admin preview.
-   Confirm RLS/storage policies and upload type/size restrictions.
-   Polish loading states, validation summaries, retry actions, empty
    states, mobile layouts, and provider errors.
-   Run lint, type-check, unit tests, and available end-to-end smoke
    tests.
-   Test direct API requests for unpaid projects.
-   Deploy with configured environment variables and private storage.
-   Produce README runbook, environment checklist, known limitations,
    and five-minute demo script.

### Acceptance

-   Unpaid direct API generation/release attempts fail.
-   Only authorized admin can release successfully generated,
    verified-paid output.
-   Customer can access only their own released deliverables.
-   Three happy paths and important failure paths are smoke-tested.
-   Deployment uses correct environment variables and private buckets.
-   Report every untested feature and every mock integration honestly.

## 6.10 Prioritization if schedule slips

Defer in this order before compromising security: 1. Interactive 3D
manipulation or CAD/BIM export. 2. Automated payment gateway/webhook
integration. 3. Full regional-language/dialect certification. 4.
Multiple image-model orchestration, bulk generation, advanced queue
infrastructure, and detailed cost optimization. 5. Advanced accounts,
team collaboration, revision history, analytics. 6. Cosmetic polish that
does not block usability or accessibility.

**Never defer:** server-side payment gate, server-side release gate,
private storage, role/ownership checks, secret protection, or mock/live
transparency.

------------------------------------------------------------------------

## Verified Implementation Checkpoint (progress ledger, not part of the original plan)

> Added after the original plan was written. Everything above this
> heading is the original plan and is unchanged. This section records
> verified progress against it and is updated in place; it does not
> change the plan's scope, order or requirements.

### Assessment

- **Assessed:** 2026-10-21 16:25 +0530.
- **Branch / HEAD:** `main` at `5ecf040c0ff8e5f5a45295ef4d45812c2fce0a91`
  (`docs: record Gates 7-9 and correct voice evidence notes`). No Git
  remote; nothing pushed; nothing staged.
- **Working tree (uncommitted):** the deterministic SVG floor plan
  (new `src/lib/generation/floor-plan.ts`,
  `src/components/generation/floor-plan.tsx`,
  `tests/unit/floor-plan.test.ts`; changed `src/lib/generation/read.ts`,
  the customer results page, the admin generation detail page and two
  test files), a 2-line `CLAUDE.md` section 19 note, and this section.
  Protected, untracked and unchanged (SHA-256 verified):
  `handoff.md`, `supabase/proposed/` (2 files),
  `tests/db/release-invariant.test.ts`.
- **Sources inspected:** this plan; `00_PROJECT_OVERVIEW.md`,
  `01_PRD.md` (PR-001 to PR-035, business rules, section 1.7
  acceptance), `08`–`11`, `13_ARCHITECTURE_DECISION.md`; the phase
  prompts in `architectural-ai-skill-integrated-prompts/`; `CLAUDE.md`
  section 19; `docs/PROVIDERS.md`; the code and tests. **Not
  inspected:** the original PDF (the derived Markdown was used).
  **Missing:** `12_CLAUDE_CODE_MASTER_PROMPT.md`,
  `docs/EXECUTION_PLAN.md`, `docs/REQUIREMENTS_TRACEABILITY.md`,
  `docs/PLANNING_DECISIONS.md`.
- **Phase numbering:** the build followed
  `architectural-ai-skill-integrated-prompts/` (Phases 1–7), which
  regroups this plan's Phases 0–6. Requirement order below follows this
  plan and the PRD IDs.

### Evidence rules

- **Fresh** = run on the current working tree on 2026-10-21:
  `npx vitest run` 49 files / 1,080 tests passed (unit tests and
  in-memory PostgreSQL; network blocked; includes the untracked
  `release-invariant.test.ts`, 5 tests); `npx tsc --noEmit
  --incremental false` and `npx eslint` clean;
  `NEXT_TELEMETRY_DISABLED=1 npm run build` passed.
- **Historical (H)** = recorded earlier against the LOCAL Supabase stack
  or a local browser, on code paths not changed since unless stated
  (sources: `CLAUDE.md` section 19, `docs/PROVIDERS.md`). Last full
  live suite 103/103 predates the Phase 6A closure fixes and R1-C.
- **Not run:** live integration suites (destructive setup), any
  interactive browser test since Phase 6A-2, any hosted environment,
  any live provider call (none has ever been made).

### Requirement status (PRD section 1.5)

| ID | Required behaviour | Evidence | Verification | Status | Remaining action |
|---|---|---|---|---|---|
| PR-001 | Three project types | `src/app/(marketing)/page.tsx`, `/new/[type]` | Fresh tests; H browser | Complete and verified | — |
| PR-002 | Validated forms usable at 360 px | `src/lib/journeys/steps.ts`, `validation.ts` | Fresh tests; no 360 px check recorded | Implemented, verification incomplete | Viewport check (browser) |
| PR-003 | Text fallback | Text-only journey; voice off by default | Fresh; H browser | Complete and verified | — |
| PR-004 | Voice capture | `src/components/journey/voice-capture.tsx`, `src/lib/voice/*` (mock transcriber) | Fresh; H headless Edge with fake microphone | Implemented, verification incomplete | Real microphone; live STT blocked |
| PR-005 | Transcript review, original kept separately | `saveStep` in `src/lib/journeys/service.ts`; migration `20261021000100` | Fresh; H local browser plus read-only query | Complete and verified (mock source) | — |
| PR-006 | Structured brief and English brief | `src/lib/journeys/brief.ts`, `src/lib/providers/openrouter.ts` | Fresh (mock and fake fetch only) | Implemented, verification incomplete | Live OpenRouter (blocked: privacy decision R3) |
| PR-007 | Missing information, never invented | `missingRequiredFields`, `missingOptionalDetails`, invented-number check | Fresh | Complete and verified | — |
| PR-008 | Edit and approve brief; gate quote | `reviewBrief`, `acceptQuote` (`service.ts`) | Fresh; H live suite | Complete and verified | — |
| PR-009 | TTS read-back or visible text fallback | `ReadbackSummary` (`src/components/journey/readback-summary.tsx`) on the brief page shows `customerReadbackText` as text and explains that listening is not available (`READBACK_TEXT_FALLBACK`, `src/lib/voice/copy.ts`); no play control | Fresh: 4 tests in `tests/unit/voice-components.test.ts`; build; no browser | Partially implemented (text fallback done; spoken read-back blocked) | Live Gnani TTS (blocked: account facts, credit rates, approval) |
| PR-010 | Reference uploads | "Uploads not configured yet" (`src/components/journey/step-form.tsx`) | — | Blocked | Owner decision: upload types, sizes, retention |
| PR-011 | Itemized quote | `src/lib/journeys/quote.ts` | Fresh; H | Complete and verified | Real rates are the owner's |
| PR-012 | Official payment instructions | `PAYMENT_*` server config; `/projects/[id]/payment` | Fresh; H (demo-labelled values) | Complete and verified | Real details are the owner's |
| PR-013 | Payment evidence creates pending only | `src/app/api/payments/route.ts`, migration guards | Fresh; H live 64/64 | Complete and verified | — |
| PR-014 | Payment status and rejection reason | Payment page | Fresh; H | Complete and verified | — |
| PR-015 | Project status and empty state | `/projects`, `src/lib/journeys/status.ts` | Fresh; H | Complete and verified | — |
| PR-016 | Released deliverables only | `getCustomerResults`, results page, SVG sketch | Fresh; browser 2026-10-21 (all three journeys, owner view after release, other customer refused) | Complete and verified (local, development server, mock assets) | — |
| PR-017 | Concept disclaimer | `src/lib/generation/copy.ts`, journey disclaimers, sketch label | Fresh | Complete and verified | — |
| PR-018 | Mock output labelled | `MOCK_WARNING`, mock brief, voice and image labels | Fresh | Complete and verified | — |
| PR-019 | Server-side admin role | `is_admin()`, `getAdminAccess` | Fresh; H live | Complete and verified | — |
| PR-020 | Payment queue, signed proof links | `/admin/payments`, 60 s links | Fresh; H | Complete and verified | — |
| PR-021 | Verify/reject with amount, note, reason | `admin_verify_payment`, `admin_reject_payment` | Fresh; H | Complete and verified | — |
| PR-022 | Generation queue | `/admin/generation`, `listGenerationQueue` | Fresh; browser 2026-10-21 (queue, review, start mock generation, release) | Complete and verified (local, development server, mock assets) | — |
| PR-023 | Preview and release control | `releaseProject`, `admin_release_project` | Fresh; browser 2026-10-21 (release with both confirmations, three journeys); H live 103/103 before closure fixes | Implemented, verification incomplete | Re-run live suite safely; proposed DB guard undecided; late-write (B1) migration |
| PR-024 | Admin pricing settings | `/admin/pricing` (`src/app/(app)/admin/pricing/page.tsx`, `actions.ts`), `src/lib/pricing/admin.ts` (`publishRuleVersion`, `getPricingOverview`), `src/components/pricing/rule-form.tsx`: an administrator publishes a new version of each rate, minimum charge, included quantity, currency and tax rate, in force immediately, written with the administrator's own session (RLS plus audit trigger) | Fresh: 42 tests in `tests/unit/pricing-{admin,actions,components}.test.ts`; build; not run against real Supabase RLS; no browser | Partially implemented | Owner decisions: discounts, payment instructions (kept in server configuration), switching quotes from demo to real rates, scheduled (future) effective dates; then live RLS and browser check |
| PR-025 | Audit trail | `audit_events` triggers | Fresh; H | Complete and verified | — |
| PR-026 | Server-side pricing | `createQuote` | Fresh; H | Complete and verified | — |
| PR-027 | Frozen quote snapshot | `quotes.line_items_json`, `pricing_rule_version`, freeze trigger | Fresh; H | Complete and verified | — |
| PR-028 | Payment gate before generation | Database guard plus `startGeneration` | Fresh; H live | Complete and verified | — |
| PR-029 | Release gate | `admin_release_project` | Fresh; H live | Complete and verified | Residual late-write risk (B1) needs a migration |
| PR-030 | Private storage | Private bucket and policies; audio never stored | Fresh; H live | Complete and verified | — |
| PR-031 | Validated model output | Zod in `brief.ts`, `openrouter.ts`, `images.ts` | Fresh | Complete and verified | — |
| PR-032 | Traceability metadata | `generation_jobs`, `ai_usage` ledger | Fresh; H ledger 16/16 | Complete and verified | — |
| PR-033 | Recoverable failure states | Many states exist; uploads and live providers absent | Fresh | Partially implemented | Upload and live-provider failure states |
| PR-034 | Configurable providers, labelled mocks | `src/lib/providers/*`, `PROVIDER_MODE`, `GNANI_VOICE_ENABLED` | Fresh (mocks) | Implemented, verification incomplete | Live verification (blocked) |
| PR-035 | Idempotency and cost controls | Job idempotency key, budget ledger, image cap | Fresh; H live | Complete and verified | — |

Plan item outside the PR list, section 6.7: **deterministic empty-plot
SVG layout** — implemented on demand without storage
(`src/lib/generation/floor-plan.ts`); fresh tests and build pass;
**implemented, verification incomplete** (no browser check). Live
OpenRouter image generation (section 6.7) is **blocked** (provider,
credentials, price, cap, privacy decision).

### Percentages (35 applicable requirements, PR-001 to PR-035, equal weight, none excluded)

| Measure | Formula | Result |
|---|---|---|
| Verified completion | complete and verified / 35 | 26 / 35 = **74.3 %** |
| Implemented, awaiting verification | that status / 35 | 5 / 35 = **14.3 %** |
| Implementation completeness | (verified + awaiting) / 35 | 31 / 35 = **88.6 %** |
| Partially implemented / missing / blocked | each / 35 | 3 (8.6 %: PR-009, PR-024, PR-033) / 0 / 1 (2.9 %: PR-010) |
| PRD section 1.7 acceptance items met | met / 16 | 12 / 16 (75 %); met since the checkpoint: the voice/TTS item through its clear text fallback (live voice is not claimed), one browser-verified end-to-end example per project type with the unpaid-generation negative test, and README/runbook, environment checklist, limitations and demo script; partly met: mobile, provider failures, secret checks, consent/retention |

### Critical invariants (section 6.10 "never defer")

| Invariant | Status |
|---|---|
| Server-side payment gate | Verified (local, H) and unchanged; fresh unit tests pass |
| Server-side release gate | Verified (local, H); application guard against failed-job files; database guard proposed, not applied; residual late-write risk documented |
| Private storage | Verified (local, H); the SVG sketch is never stored |
| Role and ownership checks | Verified (local, H); fresh tests cover the sketch's visibility |
| Secret protection | Implemented; earlier credential scans clean (H); no client-bundle scan recorded |
| Mock/live transparency | Verified (fresh tests); no live provider is wired |

### Demo readiness (09_DEMO_SCRIPT.md) and deployment

Not ready against the script. Step 2 runs only as a labelled mock (voice
and brief). Step 3 shows the SVG sketch, but the concept images come
from the mock generator. Step 4 needs reference uploads (PR-010,
blocked). Steps 1, 5 and 6 work locally with demo rates and mocks.
Step 7 has local live-suite evidence (H). **Deployment:** none; no
hosting configured; hosted Supabase does not exist.

### Blockers and owner decisions

PR-010 upload types, sizes and retention; live Gnani STT/TTS (host,
authentication, credit rates, languages); live OpenRouter brief and its
privacy notice (R3); live image generation (provider, model, price,
cap, metering migration); the proposed release guard and the B1
migration; a safe isolated plan for the live suites; competition
criteria and whether a hosted URL is required.

### Next unfinished requirement

**Section 6.9 acceptance — "Deployment uses correct environment
variables and private buckets"** (nothing is deployed) and the
remaining browser coverage: the production build in a browser, mobile
width, accessibility and receipt upload. The three happy paths and the
main failure paths were browser-smoked on 2026-10-21 (work log item 4),
so the rest of this paragraph is kept as originally written.

*Original wording of this item before that run:* **Section 6.9
acceptance — "Three happy paths and important failure paths are
smoke-tested"**, run as a local browser smoke of `docs/DEMO_SCRIPT.md`
and the three journeys. This also completes the
PRD section 1.7 items "landing page and all three flows work on mobile
and desktop" and "at least one end-to-end example exists for each
project type, with one unpaid-project negative test documented".

Why this is next:
- The section 6.9 documentation task is done as far as it can be
  without running anything (see the work log).
- Every remaining PR item either waits on an owner decision or needs
  this browser and service verification: PR-002, PR-004, PR-016,
  PR-022, PR-023, the SVG sketch, and the pricing screen against real
  row-level security.

**Prerequisite:** the owner's approval to start the local Supabase
stack and the app, and to prepare local demo data (demo pricing, demo
payment display values, an administrator row and the prepared projects
in `docs/DEMO_SCRIPT.md`). It does **not** require running the
destructive live suites. Those still need an isolated plan.

Parts of PR-024 that need an owner decision and were **not** built:
- **Discounts.** The engine fixes them at 0, and there is no
  "where permitted" policy (`11_DECISIONS_AND_OPEN_QUESTIONS.md`: tax
  and discount need business review).
- **Payment instructions.** Phase 4 kept them in protected server
  configuration (`PAYMENT_*`); making them admin-editable changes who
  can redirect payments.
- **Switching quotes from "Demo rates" to real rates** (`pricing_mode`).
- **Scheduled (future) effective dates.** Each new version takes effect
  immediately.

### Work after this checkpoint

1. **PR-009 text fallback — done (2026-10-21).**
   - Added `src/components/journey/readback-summary.tsx` and
     `READBACK_TEXT_FALLBACK` in `src/lib/voice/copy.ts`.
   - The brief page (`src/app/(app)/projects/[id]/brief/page.tsx`) now
     shows the read-back summary as text, explains that listening is not
     available, and offers no play control.
   - 4 tests in `tests/unit/voice-components.test.ts`.
   - Checks: `npx vitest run tests/unit/voice-components.test.ts` 12/12;
     `npx tsc --noEmit --incremental false` and `npx eslint` clean;
     `npx vitest run` 49 files / 1,084 tests passed;
     `NEXT_TELEMETRY_DISABLED=1 npm run build` passed with no warnings.
   - Not verified in a browser.
2. **PR-024 decision-free part — done (2026-10-21).**
   - **Service.** `src/lib/pricing/admin.ts`:
     - only the keys the quote engine reads, plus the tax rate, can be
       priced;
     - each change is a new version in force immediately; rows are
       never edited;
     - amounts are checked against numeric(12,2) with at most two
       decimals, and tax runs from 0 to 100 percent;
     - every rate of a project type must use one currency;
     - a simultaneous publish (unique violation) is reported as a
       conflict.
   - **Screen.** `/admin/pricing` with `actions.ts`; the role is checked
     from the database on every request, and writes use the
     administrator's own session (RLS `pricing_rules_admin_all`, audit
     trigger `trg_90_pricing_rules_audit`).
   - **Form.** `src/components/pricing/rule-form.tsx`.
   - **Links.** "Pricing" links added on `/admin/payments` and
     `/admin/generation`.
   - **Unchanged.** No migration, no change to the quote engine, no
     discounts, no payment-instruction or demo-mode change.
   - **Tests.** 42 in `tests/unit/pricing-admin.test.ts`,
     `pricing-actions.test.ts` and `pricing-components.test.ts`.
   - **Checks.** The new files 42/42 (after one test assertion was made
     independent of attribute order); `npx tsc --noEmit --incremental
     false` and `npx eslint` clean; `npx vitest run` 52 files / 1,126
     tests passed; `NEXT_TELEMETRY_DISABLED=1 npm run build` passed
     with no warnings (`/admin/pricing` listed).
   - **Not verified:** publishing against the real local Supabase
     (RLS, audit row), or in a browser.
3. **Section 6.9 documentation — partially complete (2026-10-21).**
   - **What was written:**
     - `README.md`, rewritten as a runbook with an environment
       checklist, known limitations, and a status table labelled by
       evidence level;
     - new `docs/DEMO_SCRIPT.md`, a timed five-minute script that keeps
       `09_DEMO_SCRIPT.md`'s seven steps, with routes, actions, expected
       results, presenter lines, a status per step and labelled
       fallbacks;
     - `CLAUDE.md` section 19 updated.
   - **No application code changed.**
   - **Checks run in this task:**
     - an offline script confirmed that every repository path, app
       route and environment-variable name the two documents mention
       exists;
     - `git diff --check` was clean;
     - every quoted interface string and test name was found in the
       code;
     - the demo's step-7 command
       `npx vitest run tests/unit/generation-service.test.ts tests/db/workflow-guards.test.ts`
       passed, 2 files / 117 tests.
   - **Why it is partial, not complete:**
     - the runbook's start-up commands (Supabase start, `next start`,
       demo data) are recorded from earlier sessions and were not
       re-run;
     - the demo path has not been run in a browser;
     - `supabase/README.md` still says start-up applies 5 migrations
       (8 exist). It was outside this task's scope, and the README
       notes it.
4. **Section 6.9 browser smoke — done on the local development server (2026-10-21).**
   - **How it ran:** a headless Edge browser drove the real UI against the local Supabase stack. The new demo customer `demo-e2e-mvi2xal6@example.test`, an existing administrator and an existing second customer signed in through the local email inbox. All writes went through the app's own forms and actions, and providers stayed mock-only.
   - **Results:** all three journeys passed every step: create, answers, brief with text read-back, quote labelled "Demo rates", payment evidence (pending), administrator verification, mock generation, release, and the owner's view of the released results. The empty-plot journey showed the two-floor sketch labelled not CAD; interior and landscape correctly showed none.
   - **Failure paths passed:**
     - a signed-out visitor on protected pages;
     - a customer on the three admin pages;
     - another customer's projects and results, before and after release;
     - results before release;
     - generation before verified payment (no start control).
   - **Records created** (local database only, all released): empty plot `d8ba4423-726c-4f1d-81ab-cd105b409a97`, interior `f8551043-29e4-46ea-ad27-d01f7aaa863f`, landscape `c1e2cff2-be25-432b-829d-ed3abf642486`. A read-only check found no pre-existing project, payment or pricing rule changed, and the provider usage ledger still empty.
   - **Not covered:** the production build in a browser, mobile width, accessibility, a real microphone, receipt-image upload, the payment-reject path, publishing a price, a forced generation failure, the live suites.
   - **Defect found in the documentation, not the product:** the demo script named the release button by its heading. Corrected in `docs/DEMO_SCRIPT.md`.
   - **Checks after the run:** `npx tsc --noEmit --incremental false` and `npx eslint` clean; `npx vitest run` 52 files / 1,126 tests passed.
