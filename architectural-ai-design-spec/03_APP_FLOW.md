# 3. APP FLOW --- Application Flow and State Machine

## 3.1 High-level customer flow

``` mermaid
flowchart TD
    A[Landing page] --> B{Choose project type}
    B --> C[Empty plot]
    B --> D[Interior refresh]
    B --> E[Landscape design]
    C --> F[Typed form and optional voice]
    D --> F
    E --> F
    F --> G[Consent and browser recording if selected]
    G --> H[Server-side STT]
    H --> I[Edit/correct transcript]
    I --> J[Combine transcript and typed fields]
    J --> K[Validated structured brief + missing-field checks]
    K --> L{Required fields resolved?}
    L -- No --> M[Ask targeted clarification questions]
    M --> J
    L -- Yes --> N[Review and approve English brief]
    N --> O[Server-calculated itemized quote]
    O --> P{Customer accepts quote?}
    P -- No --> Q[Edit/cancel or return to project]
    P -- Yes --> R[Show official transfer instructions]
    R --> S[Submit UTR/reference and optional proof]
    S --> T[Payment pending admin verification]
    T --> U{Admin confirms actual account credit?}
    U -- No --> V[Reject with reason; customer may resubmit]
    V --> R
    U -- Yes --> W[Payment verified]
    W --> X[Generate SVG plan and/or AI concepts]
    X --> Y{Generation successful?}
    Y -- No --> Z[Recoverable failure/retry]
    Z --> X
    Y -- Yes --> AA[Private assets ready for admin review]
    AA --> AB{Admin releases?}
    AB -- No --> AC[Remain private / resolve issue]
    AB -- Yes --> AD[Customer can access released results]
```

**Text-only branch:** If microphone permission, STT, or TTS is
unavailable, the user can continue using typed requirements. Do not make
voice a mandatory dependency.

## 3.2 State model

The source PDF defines this primary progression:

`DRAFT → TRANSCRIPT_READY → BRIEF_REVIEW → BRIEF_APPROVED → QUOTED → AWAITING_PAYMENT → PAYMENT_PROOF_SUBMITTED → PAYMENT_VERIFIED → GENERATING → READY_FOR_REVIEW → RELEASED`

Additional recovery/terminal states: - `PAYMENT_REJECTED` -
`GENERATION_FAILED` - `CANCELLED`

The Phase 6 prompt in the source also enumerates `GENERATION_FAILED`
explicitly. Keep state naming consistent in code and database.

### State definitions

  --------------------------------------------------------------------------------
  State                       Meaning                 Allowed next states
                                                      (policy-level)
  --------------------------- ----------------------- ----------------------------
  `DRAFT`                     Project exists;         `TRANSCRIPT_READY`,
                              requirements are being  `BRIEF_REVIEW`, `CANCELLED`
                              collected

  `TRANSCRIPT_READY`          Transcript exists or    `BRIEF_REVIEW`, `CANCELLED`
                              typed requirements are
                              ready for normalization

  `BRIEF_REVIEW`              Structured brief needs  `BRIEF_REVIEW`,
                              review/clarification    `BRIEF_APPROVED`,
                                                      `CANCELLED`

  `BRIEF_APPROVED`            Customer approved       `QUOTED`, `CANCELLED`
                              validated brief

  `QUOTED`                    Quote generated and     `AWAITING_PAYMENT`,
                              available for           `CANCELLED`
                              acceptance

  `AWAITING_PAYMENT`          Accepted quote;         `PAYMENT_PROOF_SUBMITTED`,
                              awaiting payment        `CANCELLED`
                              evidence

  `PAYMENT_PROOF_SUBMITTED`   Evidence submitted, not `PAYMENT_VERIFIED`,
                              yet verified            `PAYMENT_REJECTED`

  `PAYMENT_REJECTED`          Admin rejected evidence `AWAITING_PAYMENT`,
                              with reason             `PAYMENT_PROOF_SUBMITTED`,
                                                      `CANCELLED`

  `PAYMENT_VERIFIED`          Admin confirmed actual  `GENERATING`, `CANCELLED` if
                              receipt                 business policy permits

  `GENERATING`                Server-authorized       `READY_FOR_REVIEW`,
                              generation is running   `GENERATION_FAILED`

  `GENERATION_FAILED`         Generation failed;      `GENERATING`, `CANCELLED`
                              outputs not releasable

  `READY_FOR_REVIEW`          Deliverables exist      `RELEASED`
                              privately and await
                              admin inspection

  `RELEASED`                  Admin released          Terminal for the PoC
                              deliverables to the
                              customer

  `CANCELLED`                 Project cancelled       Terminal for the PoC
  --------------------------------------------------------------------------------

This table is a proposed transition policy based on the source workflow.
Final transition matrix must be encoded centrally and tested. Do not
allow arbitrary client-selected states.

### Mandatory transition guards

-   `BRIEF_APPROVED`: customer authenticated as project owner; required
    fields resolved; approval timestamp recorded.
-   `QUOTED`: approved brief exists; quote computed on server.
-   `AWAITING_PAYMENT`: customer accepted a valid quote; immutable quote
    snapshot retained.
-   `PAYMENT_PROOF_SUBMITTED`: accepted quote exists; validated evidence
    metadata recorded; payment remains unverified.
-   `PAYMENT_VERIFIED`: authorized admin action; actual
    receiving-account credit checked; confirmed amount and audit event
    recorded.
-   `GENERATING`: server verifies payment is `VERIFIED`, project/quote
    ownership, and idempotency/job rules.
-   `READY_FOR_REVIEW`: successful job and required assets are persisted
    privately.
-   `RELEASED`: authorized admin; payment verified; required
    deliverables exist; audit event recorded.
-   Customer asset access: authenticated owner and `RELEASED`, or
    authorized admin preview.

## 3.3 Detailed voice flow

1.  Show language selector from configuration and explicit microphone
    consent.
2.  Browser requests microphone permission.
3.  `MediaRecorder` captures audio; display recording state, elapsed
    time, stop/cancel/re-record controls.
4.  Upload audio to a protected server route.
5.  Server calls Gnani STT using server-side credentials.
6.  Show transcript and allow correction of dimensions, room
    names/counts, and architectural terms.
7.  Store original and corrected transcript separately.
8.  Delete raw audio after successful transcription unless explicit
    retention consent/configuration says otherwise.
9.  Merge corrected transcript with validated form data and request
    structured brief.
10. Optionally synthesize read-back using configured voice/language. If
    unavailable, display text fallback.

## 3.4 Brief normalization flow

1.  Receive project type, validated form JSON, corrected transcript, and
    reference-asset metadata.
2.  Build a server-side prompt with a version identifier.
3.  Call the configured text model through OpenRouter.
4.  Parse and validate the result using Zod.
5.  Reject malformed JSON; never silently coerce unknown output into
    trusted facts.
6.  Populate `missingRequiredFields`, `assumptions`, `englishBrief`,
    `customerReadbackText`, and `imagePrompts`.
7.  Ask targeted clarification questions for required missing values.
8.  Present transcript, structured summary, assumptions, missing
    details, and editable English brief.
9.  Require customer approval before quote acceptance.

## 3.5 Generation flow

-   Verify project/payment state on the server before any provider call.
-   For empty plot, generate a deterministic SVG from validated
    room/layout data; do not use an image model for precise
    labels/dimensions.
-   For all types, prepare prompt from approved brief and versioned
    prompt template.
-   Include reference images only if the selected provider/model
    supports them.
-   Enforce image count, file size, resolution, and timeout.
-   Record provider/model, prompt version, request/job ID, duration,
    usage/cost if returned, attempt count, and errors.
-   Save results in private storage.
-   Keep assets inaccessible to customers until admin release.
-   Admin previews outputs and explicitly releases them.

## 3.6 Pricing and payment flow

1.  Customer approves brief.
2.  Server computes an itemized quote from configured rules.
3.  Customer accepts quote; persist frozen line items and pricing
    version.
4.  Show official payment instructions from server configuration.
5.  Customer submits UTR/reference, transfer date, claimed amount,
    method, and optional proof.
6.  Payment status becomes `PAYMENT_PROOF_SUBMITTED`.
7.  Admin checks the actual receiving account and either verifies or
    rejects with a reason.
8.  Verified payment enables generation, but does not release assets.
9.  Admin releases outputs only after review.

------------------------------------------------------------------------
