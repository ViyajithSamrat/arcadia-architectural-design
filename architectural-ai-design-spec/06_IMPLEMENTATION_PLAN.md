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
