# 1. PRD --- Product Requirements Document

## 1.1 Product vision

Provide a clear, accessible workflow for homeowners and customers to
describe an architectural, interior, or landscaping concept in their
preferred supported language, review the normalized requirements in
English, understand the price, submit payment evidence, and securely
receive conceptual design outputs.

## 1.2 Problem statement

Customers may find it difficult to translate ideas into a structured
design brief. Voice input can make requirement capture easier, but
speech transcription can mishear room counts, dimensions, names, and
local terms. Generative image models can create attractive visual
concepts but may alter geometry or invent details. A safe workflow
therefore needs editable transcription, explicit clarification, customer
approval, deterministic rendering for labelled 2D plans, transparent
pricing, human payment verification, and controlled release.

## 1.3 Target users and roles

### Customer

-   Chooses one of the three project types.
-   Enters requirements by text and/or voice.
-   Corrects transcripts and resolves missing information.
-   Reviews and approves the English brief.
-   Reviews and accepts an itemized quote.
-   Submits transfer reference and optional payment proof.
-   Views released design deliverables.

### Administrator / operator

-   Reviews submitted payment evidence against the actual receiving
    account.
-   Verifies or rejects a payment with an audit note/reason.
-   Reviews generation jobs and errors.
-   Previews generated deliverables.
-   Releases eligible deliverables to the owning customer.
-   Manages pricing rules and site settings through protected admin
    operations.

### System / external providers

-   Authenticates users, stores project records and private assets.
-   Calls speech, text, and image providers through server-side
    adapters.
-   Validates model output and enforces workflow transitions.
-   Calculates quotes using server-owned pricing rules.
-   Records audit events and job metadata.

## 1.4 Core user journeys

### Journey A --- Empty plot to building concept

The customer provides plot dimensions and units, optional orientation,
built-up area, floors, room program, bedroom/bathroom counts,
kitchen/dining/living needs, stairs, parking, optional
balcony/utility/study/puja/storage rooms, style, budget band,
location/climate, optional Vastu preferences, and requested views. The
system creates a validated brief, labelled illustrative SVG plan, and
one or more static AI perspective concepts.

### Journey B --- Existing apartment to interior concepts

The customer provides reference photos and/or an existing floor plan,
rooms to redesign, approximate dimensions if known, style,
colour/material preferences, storage needs, budget, fixed features that
must remain unchanged, and requested views. The system creates a brief
per selected room, AI concept images when reference-image input is
supported, and a text summary of palette, finishes, furniture, lighting,
and storage ideas.

### Journey C --- Existing house to landscaping concepts

The customer selects front yard, backyard, side yard, or terrace;
supplies approximate area, city/climate, sunlight, water availability,
maintenance tolerance, relevant pet/child considerations, features to
retain, pathways/hardscape, seating, privacy, vegetable/herb garden,
style, and requested views. The system creates a landscape brief and
concept images plus design-element suggestions.

## 1.5 Functional requirements

IDs are stable references for implementation and testing.

### Customer experience

-   **PR-001 --- Project type selection:** Landing page presents three
    distinct project types: New Build on Empty Plot, Interior Refresh,
    and Landscape Design.
-   **PR-002 --- Responsive forms:** Each project type has a dedicated,
    typed, validated, multi-step form. Forms must remain usable at 360
    px mobile width and desktop sizes.
-   **PR-003 --- Text fallback:** Text entry must support the full
    workflow when microphone permission or speech services are
    unavailable.
-   **PR-004 --- Voice capture:** Where enabled, customers can select a
    configured language, consent to recording,
    start/stop/cancel/re-record, see recording state and elapsed time,
    and upload audio securely.
-   **PR-005 --- Transcript review:** Show the transcript for editing.
    Preserve the original transcript separately from the corrected
    transcript.
-   **PR-006 --- Brief normalization:** Combine corrected transcript and
    validated form fields into a structured JSON brief and professional
    English brief.
-   **PR-007 --- Missing information:** Ask specific follow-up questions
    for missing critical fields. Never silently invent dimensions, room
    counts, budget, site constraints, or compliance requirements.
-   **PR-008 --- Approval gate:** Customer can edit and approve the
    brief. Quote acceptance and generation must remain disabled until
    required details are resolved and the brief is approved.
-   **PR-009 --- Read-back:** Offer TTS read-back for approved
    summaries/clarifications in a configured supported language. If
    unavailable, keep text visible and explain the fallback.
-   **PR-010 --- Reference uploads:** Customers can upload reference
    photos and/or floor plans where relevant. Validate type and size,
    show thumbnails/progress, and allow removal/replacement.
-   **PR-011 --- Quote display:** Show itemized line items, currency,
    configured taxes/fees, discount, total, validity if configured, and
    clear acceptance action.
-   **PR-012 --- Payment instructions:** Show official server-configured
    UPI QR/ID and/or bank-transfer details after quote acceptance.
-   **PR-013 --- Payment evidence:** Collect transfer reference/UTR,
    transfer date, amount, method (UPI or NETBANKING), and optional
    receipt image. Submission creates a pending payment, never a
    verified one.
-   **PR-014 --- Payment status:** Customer sees pending, verified, or
    rejected status and a rejection reason when provided.
-   **PR-015 --- Project status:** Customer can see progress/status and
    an empty state when no projects exist.
-   **PR-016 --- Released deliverables:** Customer can view/download
    released deliverables only after the release gate succeeds.
-   **PR-017 --- Concept disclaimer:** Clearly identify all generated
    design imagery and schematic layouts as conceptual, not
    construction-ready.
-   **PR-018 --- Demo transparency:** Mock assets and mock provider
    responses must be visibly labelled as demo/mock output.

### Admin experience

-   **PR-019 --- Protected admin access:** Admin role is assigned and
    checked server-side. Do not use a shared hard-coded admin password.
-   **PR-020 --- Payment queue:** Admin can review pending payment
    submissions and view private proof through authenticated,
    time-limited signed URLs.
-   **PR-021 --- Verify/reject:** Admin can verify or reject a payment
    with confirmed amount, audit note, and rejection reason where
    applicable.
-   **PR-022 --- Generation queue:** Admin can inspect generation
    status, failures, attempts, and deliverables.
-   **PR-023 --- Release control:** Admin can preview generated outputs
    and release only when payment is verified and deliverables are
    available.
-   **PR-024 --- Pricing settings:** Authorized admin can configure
    project-type pricing, included quantities, add-ons, minimum charges,
    currency, taxes/fees, discounts where permitted, effective dates,
    and payment instructions.
-   **PR-025 --- Auditability:** Payment verification/rejection,
    generation, and release actions are recorded with actor and
    timestamp.

### Backend and AI behavior

-   **PR-026 --- Server-side pricing:** Final quotes are calculated on
    the server, not trusted from browser-supplied totals.
-   **PR-027 --- Quote snapshot:** Accepted quote stores an immutable
    line-item snapshot and pricing-rule version; future rate changes
    must not silently change accepted quotes.
-   **PR-028 --- Payment gate:** A server-side transition to
    `GENERATING` requires `payment_status = VERIFIED`.
-   **PR-029 --- Release gate:** A server-side transition to `RELEASED`
    requires verified payment, available deliverables, and authorized
    admin action.
-   **PR-030 --- Private storage:** Reference photos, payment proof,
    audio when retained, and generated assets remain private until
    authorized access is granted.
-   **PR-031 --- Model validation:** Validate model output with Zod or
    equivalent. Never accept model-generated prices or payment status.
-   **PR-032 --- Traceability:** Store provider/model IDs, prompt
    version, job status, attempt count, relevant request IDs, duration
    and usage/cost when returned.
-   **PR-033 --- Recoverable failures:** Missing credentials,
    unsupported language, malformed model response, rate limits,
    timeout, empty image result, and upload failures must produce clear
    recoverable states.
-   **PR-034 --- Configurable providers:** Use provider interfaces and
    server-side configuration for Gnani STT/TTS and OpenRouter
    text/image generation; support visibly labelled mocks for
    development/demo fallback.
-   **PR-035 --- Idempotency/cost controls:** Where supported, use
    job/idempotency keys, conservative retries, image-count/resolution
    caps, timeouts, and cost logging to avoid duplicate charges and
    uncontrolled spend.

## 1.6 Business rules

1.  A customer approves the brief before final quote acceptance.
2.  The server owns the final price calculation and official payment
    destination.
3.  Submitted payment proof is evidence for review, not proof that a
    transfer occurred.
4.  Only an operator with access to the receiving account can confirm
    receipt.
5.  Payment verification enables generation but does not automatically
    publish private outputs.
6.  Only an authorized admin can release a generated result.
7.  A customer can access only their own project and its released
    assets.
8.  An admin can access protected records only after server-side role
    authorization.
9.  Missing measurements are marked unknown/approximate; assumptions are
    explicitly labelled.
10. No model-generated content may claim building-code, structural,
    fire-safety, setback, Vastu, or professional validation unless
    separately reviewed and validated by qualified professionals.
11. Official payment instructions are sourced from protected server
    configuration; customers cannot nominate the official receiving UPI
    ID.
12. Raw audio should be deleted after successful transcription unless
    explicit consent and a retention policy authorize storage.
13. Demo placeholder rates must be labelled and must not be represented
    as real commercial prices.

## 1.7 Acceptance criteria

The PoC is accepted when: - The landing page and all three flows work on
mobile and desktop. - Each flow supports text-only entry. - Voice
capture, STT, transcript editing, and TTS work for agreed priority
languages or fall back clearly to text. - Brief output preserves
supplied measurements/counts and flags missing information. - Customer
approval is required before quote acceptance. - Quote is itemized,
server-calculated, and frozen on acceptance. - Payment submission
creates a pending record. - Server checks admin role for every
verification/rejection/release mutation. - Direct API calls cannot
generate for an unpaid project. - Customers cannot fetch another
customer's project, payment proof, or assets. - Unreleased output is not
exposed through customer routes. - Provider failures are recoverable and
mock results are labelled. - Secrets are absent from browser bundles,
logs, screenshots, and source control. - Private buckets/RLS, upload
restrictions, audit logs, and voice-consent/retention controls are
configured. - At least one end-to-end example exists for each project
type, with one unpaid-project negative test documented. -
README/runbook, environment checklist, limitations, and demo script are
ready.

## 1.8 Success measures for the PoC

The PDF defines qualitative acceptance rather than numeric product KPIs.
Use the following **proposed demo measures**, not business guarantees: -
3/3 project journeys can reach a saved brief and quote. - 100% of
generation API tests reject unverified payments. - 100% of customer
asset-access tests reject cross-customer and unreleased access. - 100%
of admin mutations require server-validated admin authorization. - 0
provider secrets exposed in client bundles or logs. - Every mock output
visibly identifies itself as mock/demo output. - Critical flow passes
are recorded in a repeatable smoke-test checklist.

------------------------------------------------------------------------
