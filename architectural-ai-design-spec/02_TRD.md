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
  ├── Project type + typed forms
  ├── MediaRecorder / transcript editor
  ├── Brief review + approval
  ├── Quote + payment evidence
  └── Released-results gallery
          │ HTTPS
          ▼
Next.js App Router / Server Route Handlers
  ├── Authentication + authorization
  ├── Project workflow/state machine
  ├── Zod validation
  ├── BriefProvider ───────────────► OpenRouter text model
  ├── SpeechToTextProvider ────────► Gnani STT
  ├── TextToSpeechProvider ────────► Gnani TTS
  ├── ImageGenerationProvider ─────► OpenRouter Image API
  ├── Server-side quote engine
  ├── Payment verification/release rules
  └── Signed URL creation
          │
          ├── Supabase Postgres (records, rules, statuses, audit)
          └── Supabase Storage (private uploads and outputs)
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
├── app/
│   ├── (marketing)/
│   │   └── page.tsx
│   ├── projects/
│   │   ├── new/page.tsx
│   │   ├── [projectId]/page.tsx
│   │   ├── [projectId]/brief/page.tsx
│   │   ├── [projectId]/quote/page.tsx
│   │   ├── [projectId]/payment/page.tsx
│   │   └── [projectId]/results/page.tsx
│   ├── admin/
│   │   ├── page.tsx
│   │   ├── payments/page.tsx
│   │   ├── generations/page.tsx
│   │   └── pricing/page.tsx
│   └── api/
│       ├── health/route.ts
│       ├── projects/route.ts
│       ├── projects/[projectId]/route.ts
│       ├── speech/transcribe/route.ts
│       ├── speech/synthesize/route.ts
│       ├── briefs/route.ts
│       ├── quotes/route.ts
│       ├── payments/route.ts
│       ├── payments/[paymentId]/verify/route.ts
│       ├── payments/[paymentId]/reject/route.ts
│       ├── generation/route.ts
│       ├── admin/projects/[projectId]/release/route.ts
│       └── assets/[assetId]/access/route.ts
├── components/
│   ├── ui/
│   ├── project/
│   ├── voice/
│   ├── brief/
│   ├── quote/
│   ├── payment/
│   ├── gallery/
│   └── admin/
├── lib/
│   ├── config/
│   ├── auth/
│   ├── db/
│   ├── validation/
│   ├── workflow/
│   ├── pricing/
│   ├── storage/
│   ├── providers/
│   │   ├── interfaces.ts
│   │   ├── gnani/
│   │   ├── openrouter/
│   │   └── mocks/
│   ├── prompts/
│   └── logging/
├── supabase/
│   ├── migrations/
│   └── seed.sql
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── .env.example
├── README.md
└── package.json
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

# Supabase — server-only values where applicable
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Gnani — exact names/endpoints must match the account's current API
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

# Application limits — final values are product-owner decisions
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

-   Empty plot: text or voice → corrected transcript → approved brief →
    quote → payment submission → admin verification → generation → admin
    release → customer results.
-   Interior: upload reference → brief → quote/payment path → generated
    concept → release.
-   Landscape: climate/site inputs → brief → quote/payment path →
    generated concept → release.
-   Negative test: direct API generation attempt for an unpaid project
    is denied.
-   Fallback test: mock mode and speech-provider failure are clearly
    labelled/handled.

------------------------------------------------------------------------
