# 2. TRD --- Technical Requirements Document

## 2.1 Recommended technology stack

  -----------------------------------------------------------------------------
  Layer                   Recommendation from     Responsibility
                          source PDF
  ----------------------- ----------------------- -----------------------------
  Web application         Next.js App Router +    Customer pages, admin pages,
                          TypeScript              server route handlers

  UI system               Tailwind CSS,           Responsive accessible
                          shadcn/ui, Lucide icons interface and reusable
                                                  components

  Database                Supabase Postgres       Projects, quotes, payments,
                                                  jobs, assets, pricing,
                                                  settings, audit events

  Authentication          Supabase Auth           Email magic link/OTP;
                                                  server-assigned admin role

  Object storage          Supabase Storage,       Reference images, optional
                          private buckets         retained audio, payment
                                                  proofs, generated outputs

  Speech-to-text          Gnani Prisma via        Transcribe browser recordings
                          server-only adapter

  Text-to-speech          Gnani Timbre via        Read back approved
                          server-only adapter     summaries/questions where
                                                  supported

  Brief/JSON model        Configurable text model Requirement normalization and
                          through OpenRouter      English brief

  Image generation        OpenRouter Image API    Exterior/interior/landscape
                                                  concept images

  Validation              Zod + server-side       Runtime validation of forms,
                          business rules          provider responses,
                                                  transitions

  Tests                   Unit tests; Playwright  Pricing/state rules, security
                          smoke flows if time     gates, journey checks
                          permits

  Hosting                 Vercel + Supabase, or   Hosted demo
                          already-approved
                          equivalent
  -----------------------------------------------------------------------------

### Provider validation on Day 1

Before implementation depends on an external provider: - Confirm Gnani
credentials, exact endpoint, authentication scheme, API
version/protocol, enabled languages/voices, quotas, and response
shape. - Do not assume legacy gRPC examples and current REST APIs use
the same protocol. - Confirm OpenRouter image endpoint/model support,
reference-image inputs, image dimensions/aspect ratios, availability,
and current prices. - Treat vendor-reported language coverage as
unverified until tested with intended customer recordings. - Keep model
IDs and fallback model IDs configurable.

## 2.2 Logical architecture

``` text
Browser / Customer UI
  â”œâ”€â”€ Project type + typed forms
  â”œâ”€â”€ MediaRecorder / transcript editor
  â”œâ”€â”€ Brief review + approval
  â”œâ”€â”€ Quote + payment evidence
  â””â”€â”€ Released-results gallery
          â”‚ HTTPS
          â–¼
Next.js App Router / Server Route Handlers
  â”œâ”€â”€ Authentication + authorization
  â”œâ”€â”€ Project workflow/state machine
  â”œâ”€â”€ Zod validation
  â”œâ”€â”€ BriefProvider â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–º OpenRouter text model
  â”œâ”€â”€ SpeechToTextProvider â”€â”€â”€â”€â”€â”€â”€â”€â–º Gnani STT
  â”œâ”€â”€ TextToSpeechProvider â”€â”€â”€â”€â”€â”€â”€â”€â–º Gnani TTS
  â”œâ”€â”€ ImageGenerationProvider â”€â”€â”€â”€â”€â–º OpenRouter Image API
  â”œâ”€â”€ Server-side quote engine
  â”œâ”€â”€ Payment verification/release rules
  â””â”€â”€ Signed URL creation
          â”‚
          â”œâ”€â”€ Supabase Postgres (records, rules, statuses, audit)
          â””â”€â”€ Supabase Storage (private uploads and outputs)
```

**Trust boundaries:** The browser is untrusted. Model responses are
untrusted. Customer-supplied amounts/statuses are untrusted. Only
server-side code may calculate final prices, verify roles, change
privileged statuses, start generation, and issue authorized asset
access.

## 2.3 Suggested repository structure

The exact structure must adapt to an existing repository. Do not
overwrite unrelated code or replace an established sound architecture
without reason.

``` text
.
â”œâ”€â”€ app/
â”‚   â”œâ”€â”€ (marketing)/
â”‚   â”‚   â””â”€â”€ page.tsx
â”‚   â”œâ”€â”€ projects/
â”‚   â”‚   â”œâ”€â”€ new/page.tsx
â”‚   â”‚   â”œâ”€â”€ [projectId]/page.tsx
â”‚   â”‚   â”œâ”€â”€ [projectId]/brief/page.tsx
â”‚   â”‚   â”œâ”€â”€ [projectId]/quote/page.tsx
â”‚   â”‚   â”œâ”€â”€ [projectId]/payment/page.tsx
â”‚   â”‚   â””â”€â”€ [projectId]/results/page.tsx
â”‚   â”œâ”€â”€ admin/
â”‚   â”‚   â”œâ”€â”€ page.tsx
â”‚   â”‚   â”œâ”€â”€ payments/page.tsx
â”‚   â”‚   â”œâ”€â”€ generations/page.tsx
â”‚   â”‚   â””â”€â”€ pricing/page.tsx
â”‚   â””â”€â”€ api/
â”‚       â”œâ”€â”€ health/route.ts
â”‚       â”œâ”€â”€ projects/route.ts
â”‚       â”œâ”€â”€ projects/[projectId]/route.ts
â”‚       â”œâ”€â”€ speech/transcribe/route.ts
â”‚       â”œâ”€â”€ speech/synthesize/route.ts
â”‚       â”œâ”€â”€ briefs/route.ts
â”‚       â”œâ”€â”€ quotes/route.ts
â”‚       â”œâ”€â”€ payments/route.ts
â”‚       â”œâ”€â”€ payments/[paymentId]/verify/route.ts
â”‚       â”œâ”€â”€ payments/[paymentId]/reject/route.ts
â”‚       â”œâ”€â”€ generation/route.ts
â”‚       â”œâ”€â”€ admin/projects/[projectId]/release/route.ts
â”‚       â””â”€â”€ assets/[assetId]/access/route.ts
â”œâ”€â”€ components/
â”‚   â”œâ”€â”€ ui/
â”‚   â”œâ”€â”€ project/
â”‚   â”œâ”€â”€ voice/
â”‚   â”œâ”€â”€ brief/
â”‚   â”œâ”€â”€ quote/
â”‚   â”œâ”€â”€ payment/
â”‚   â”œâ”€â”€ gallery/
â”‚   â””â”€â”€ admin/
â”œâ”€â”€ lib/
â”‚   â”œâ”€â”€ config/
â”‚   â”œâ”€â”€ auth/
â”‚   â”œâ”€â”€ db/
â”‚   â”œâ”€â”€ validation/
â”‚   â”œâ”€â”€ workflow/
â”‚   â”œâ”€â”€ pricing/
â”‚   â”œâ”€â”€ storage/
â”‚   â”œâ”€â”€ providers/
â”‚   â”‚   â”œâ”€â”€ interfaces.ts
â”‚   â”‚   â”œâ”€â”€ gnani/
â”‚   â”‚   â”œâ”€â”€ openrouter/
â”‚   â”‚   â””â”€â”€ mocks/
â”‚   â”œâ”€â”€ prompts/
â”‚   â””â”€â”€ logging/
â”œâ”€â”€ supabase/
â”‚   â”œâ”€â”€ migrations/
â”‚   â””â”€â”€ seed.sql
â”œâ”€â”€ tests/
â”‚   â”œâ”€â”€ unit/
â”‚   â”œâ”€â”€ integration/
â”‚   â””â”€â”€ e2e/
â”œâ”€â”€ .env.example
â”œâ”€â”€ README.md
â””â”€â”€ package.json
```

This is a suggested layout, not a mandate to create every route/file
before the vertical slice works.

## 2.4 Configuration and secrets

Use server-only environment variables. Never expose provider credentials
in browser JavaScript or `NEXT_PUBLIC_*` variables.

Example `.env.example` (placeholders only):

``` dotenv
# App
APP_URL=http://localhost:3000
APP_ENV=development
PROVIDER_MODE=mock

# Supabase â€” server-only values where applicable
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Gnani â€” exact names/endpoints must match the account's current API
GNANI_API_KEY=
GNANI_STT_ENDPOINT=
GNANI_TTS_ENDPOINT=
GNANI_STT_MODEL=
GNANI_TTS_MODEL=
GNANI_DEFAULT_LANGUAGE=

# OpenRouter
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_TEXT_MODEL=
OPENROUTER_IMAGE_MODEL=
OPENROUTER_IMAGE_FALLBACK_MODEL=

# Application limits â€” final values are product-owner decisions
MAX_UPLOAD_BYTES=
MAX_AUDIO_BYTES=
MAX_GENERATION_IMAGES=
PROVIDER_TIMEOUT_MS=
SIGNED_URL_TTL_SECONDS=
```

-   Keep `.env.local` out of version control.
-   Validate required environment values at server startup or route
    entry.
-   Use Supabase's public/anon key only in the intended client-side
    configuration with RLS correctly enabled; service-role keys must
    remain server-only.
-   Add a health/readiness route that reports configuration presence
    without returning secret values.
-   Use structured logs with request/job IDs; never log credentials, raw
    private image bytes, bank credentials, or unnecessary sensitive
    content.

## 2.5 Provider interfaces

Use provider abstractions so live integrations and clearly labelled
mocks share a contract.

``` ts
export interface SpeechToTextProvider {
  transcribe(input: {
    audio: Blob | Buffer;
    language: string;
    requestId: string;
  }): Promise<{ transcript: string; provider: string; model?: string }>;
}

export interface TextToSpeechProvider {
  synthesize(input: {
    text: string;
    language: string;
    voice?: string;
    requestId: string;
  }): Promise<{ audio: Uint8Array; mimeType: string; provider: string; model?: string }>;
}

export interface BriefProvider {
  createBrief(input: {
    projectType: "EMPTY_PLOT" | "INTERIOR" | "LANDSCAPE";
    sourceLanguage: string;
    transcriptCorrected?: string;
    validatedForm: unknown;
    referenceAssetMetadata: unknown[];
  }): Promise<unknown>;
}

export interface ImageGenerationProvider {
  generate(input: {
    prompt: string;
    referenceAssets?: unknown[];
    count: number;
    requestId: string;
  }): Promise<{
    outputs: Array<{ bytes?: Uint8Array; url?: string; mimeType?: string }>;
    provider: string;
    model: string;
    usage?: unknown;
  }>;
}
```

**Implementation note:** Adapt types to the selected SDK and avoid
sending browser `Blob` objects directly into server internals without a
defined upload/parse step. Validate all returned provider data before
persistence. Do not persist an external provider URL as a public asset
URL; ingest generated bytes into private storage where the provider's
terms and API permit.

## 2.6 API surface (proposed route contract)

The PDF specifies workflows, not exact URL paths. The following
REST-style paths are proposed to make implementation consistent.

  ---------------------------------------------------------------------------------------------
  Operation               Suggested route                          Key server checks
  ----------------------- ---------------------------------------- ----------------------------
  Health                  `GET /api/health`                        No secrets in response

  Create project          `POST /api/projects`                     Authenticated customer;
                                                                   valid project type/input

  Read project            `GET /api/projects/:id`                  Owner or authorized admin

  Update draft            `PATCH /api/projects/:id`                Owner; valid transition and
                                                                   schema

  Transcribe audio        `POST /api/speech/transcribe`            Auth, consent, file
                                                                   type/size, rate limit

  Synthesize speech       `POST /api/speech/synthesize`            Auth, configured
                                                                   language/voice, timeout

  Normalize brief         `POST /api/briefs`                       Owner; validated fields;
                                                                   provider output schema

  Approve brief           `POST /api/projects/:id/approve-brief`   Owner; required fields
                                                                   resolved

  Calculate quote         `POST /api/quotes`                       Server-owned pricing rules
                                                                   and input validation

  Accept quote            `POST /api/quotes/:id/accept`            Owner; quote belongs to
                                                                   project and is valid

  Submit payment proof    `POST /api/payments`                     Owner; accepted quote;
                                                                   validate
                                                                   reference/date/amount/file

  Verify payment          `POST /api/payments/:id/verify`          Admin role; confirmed
                                                                   amount; audit event

  Reject payment          `POST /api/payments/:id/reject`          Admin role; required reason;
                                                                   audit event

  Start generation        `POST /api/generation`                   Owner/admin policy; server
                                                                   verifies payment is
                                                                   VERIFIED; idempotency

  Inspect job             `GET /api/generation/:id`                Project owner or admin; no
                                                                   private asset leakage

  Release output          `POST /api/admin/projects/:id/release`   Admin role; verified payment
                                                                   and available deliverables

  Access asset            `GET /api/assets/:id/access`             Owner + RELEASED, or
                                                                   authorized admin preview;
                                                                   signed URL
  ---------------------------------------------------------------------------------------------

Use the repository's established API conventions if different. Do not
treat these suggested paths as an externally promised public API.

## 2.7 Validation rules

-   Use Zod schemas for each project type and provider response.
-   Enforce enum values for project type, payment method, job status,
    asset type, and workflow state.
-   Validate dimensions, units, counts, date formats, file MIME types,
    file size, and requested image count.
-   Preserve unknown/missing values as `null` or explicit missing
    fields; do not invent values.
-   Distinguish customer-provided facts from assumptions.
-   Never trust a `total_amount`, `payment_status`, `is_admin`,
    `is_released`, or owner ID submitted by a browser.
-   Confirm object ownership on every project-specific operation.
-   Validate model output before it can affect quote inputs, plan
    generation, or image prompts.
-   Avoid unsafe SVG insertion; render only server-generated/validated
    SVG data and escape labels.

## 2.8 Security and privacy requirements

1.  Supabase Auth for customer identity; admin privileges assigned and
    checked server-side.
2.  RLS on project-related database tables and restrictive storage
    policies.
3.  Private storage buckets for reference images, audio where retained,
    payment proofs, and generated assets.
4.  Signed URLs with short configurable expiry, issued only after
    authorization.
5.  Upload allow-list, size caps, safe filenames/object paths, and
    content-type validation; consider file signature inspection.
6.  Rate limits/throttling on speech, text, and image generation
    endpoints.
7.  Provider timeouts, bounded retries, image-count/resolution limits,
    and spend/cost logs.
8.  Audit events for verification, rejection, generation, and release.
9.  No bank login, netbanking password, OTP, card PIN, or UPI PIN
    collection.
10. No public URLs for unreleased outputs or payment proofs.
11. Explicit microphone consent and audio-retention/deletion behavior.
12. Safe, non-sensitive error messages to customers; detailed
    diagnostics remain in protected logs.
13. Avoid storing unnecessary audio or sensitive upload metadata.
14. Production deployment must use platform secret management and
    least-privilege credentials.

## 2.9 Reliability and operational behavior

-   Provider adapter has bounded timeout and conservative retry for
    transient failures.
-   A generation job has an attempt count and stable job/request ID.
-   Duplicate requests should not accidentally start multiple paid
    generations; use an idempotency key or deduplication record where
    feasible.
-   A failed job moves to a recoverable failure state and exposes a
    retry action only when safe.
-   Empty/malformed model output must not be treated as success.
-   External provider outages must not break text-only requirement
    capture.
-   Mock mode is allowed for local development and contingency demos but
    must be visibly identified and must never be reported as a live
    provider result.
-   Provide basic request/job correlation in logs and show clear
    user-facing status.

## 2.10 Testing requirements

### Unit tests

-   Pricing arithmetic, minimum charges, included quantities,
    tax/discount rules, quote snapshot behavior.
-   Allowed and forbidden workflow state transitions.
-   Brief schema validation and missing-field behavior.
-   Role/ownership/release policy helpers.
-   File-validation rules.

### Integration tests

-   Provider timeout/malformed response/missing credentials.
-   Payment submission stays pending.
-   Admin verification/rejection writes audit events.
-   Generation rejects unpaid projects.
-   Release rejects missing deliverables or unverified payment.
-   Asset endpoint rejects another customer's asset and unreleased
    assets.

### End-to-end smoke tests

-   Empty plot: text or voice â†’ corrected transcript â†’ approved brief â†’
    quote â†’ payment submission â†’ admin verification â†’ generation â†’ admin
    release â†’ customer results.
-   Interior: upload reference â†’ brief â†’ quote/payment path â†’ generated
    concept â†’ release.
-   Landscape: climate/site inputs â†’ brief â†’ quote/payment path â†’
    generated concept â†’ release.
-   Negative test: direct API generation attempt for an unpaid project
    is denied.
-   Fallback test: mock mode and speech-provider failure are clearly
    labelled/handled.

------------------------------------------------------------------------
