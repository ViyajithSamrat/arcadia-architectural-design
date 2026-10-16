# 4. UI / UX DOCUMENT

## 4.1 Design principles

-   **Brand feel:** modern, calm, premium, trustworthy; resemble an
    architectural studio rather than a generic AI chatbot.
-   **Visual language:** warm off-white background, charcoal typography,
    restrained deep-green or terracotta accent, generous whitespace,
    strong editorial headings, subtle shadows, consistent card radii,
    and clear iconography.
-   **Clarity:** one major decision per step, grouped fields, concise
    help text, visible progress, and no extremely long form.
-   **Trust:** explain why information is needed, show where uploads are
    stored privately, distinguish facts from assumptions, display
    manual-payment status, and disclose conceptual limitations.
-   **Resilience:** text fallback, visible errors, retry actions, empty
    states, and explicit mock/live labels.
-   **Accessibility:** semantic headings, associated labels, keyboard
    navigation, visible focus, sufficient contrast, status text/icons
    (not colour alone), and accessible recording controls.
-   **Responsive design:** usable at 360 px mobile width; admin
    workflows must not depend exclusively on wide tables.

## 4.2 Navigation

### Customer navigation

`Home | New Build | Interior Design | Landscaping | My Projects`

### Admin-only navigation

`Admin | Payments | Generations | Pricing Settings`

Admin links must not be rendered as proof of authorization. Server
routes must independently verify admin membership.

## 4.3 Page inventory

  -------------------------------------------------------------------------
  Page / screen           Main content              Key actions
  ----------------------- ------------------------- -----------------------
  Landing                 Hero, primary CTA "Start  Choose project type
                          a design brief", three
                          service cards,
                          how-it-works, disclaimer,
                          footer

  Project-type form       Multi-step form specific  Save draft, continue,
                          to empty                  upload, record
                          plot/interior/landscape   requirements

  Voice capture           Language selector,        Start, stop, cancel,
                          consent, recording        re-record
                          indicator, timer,
                          controls

  Transcript review       Original transcript,      Edit, retry, continue
                          editable corrected
                          transcript,
                          upload/transcription
                          errors

  Brief review            Structured summary,       Answer clarifications,
                          assumptions, missing      edit, approve
                          fields, English brief
                          editor

  Quote                   Line-item breakdown,      Accept quote
                          currency, taxes/fees,
                          discount, total, validity

  Payment                 Official UPI/bank         Submit payment evidence
                          instructions, QR/ID,
                          total, transfer form,
                          optional proof upload

  Project status          Timeline/status, next     Continue,
                          action, payment status,   correct/resubmit, view
                          generation status         released results

  Results gallery         Released concept grid, AI Zoom/download after
                          Concept badge, brief      release
                          summary, status,
                          disclaimer

  Admin overview          Counts/queues, pending    Open queue
                          payments, failed/active
                          generation jobs

  Admin payments          Payment details, private  Verify or reject with
                          proof preview,            reason
                          claimed/confirmed
                          amounts, history

  Admin generations       Job state,                Retry where safe,
                          model/provider, error     inspect, release
                          summary, attempts,
                          preview

  Pricing settings        Rates, units, minimums,   Save validated rules
                          included quantities,
                          add-ons, currency, tax,
                          effective dates

  Auth/error/empty states Sign-in expired,          Retry, sign in, return
                          unauthorized, no
                          projects, upload error,
                          provider unavailable
  -------------------------------------------------------------------------

## 4.4 Multi-step form structure

Avoid one extremely long form. Use a reusable step indicator and persist
draft state where practical.

### Empty plot form

1.  **Your space:** plot width/length, unit, optional orientation,
    built-up area, floors, location/climate.
2.  **Rooms and circulation:** bedrooms, bathrooms,
    kitchen/dining/living, stairs, parking, balcony/utility, optional
    study/puja/storage.
3.  **Your preferences:** style, budget band, optional Vastu preference,
    number of views.
4.  **Voice or text:** typed description and optional voice recording.
5.  **Review brief:** transcript, structured data, assumptions, missing
    details, English brief.

### Interior form

1.  **Existing space:** room(s), approximate dimensions if known,
    reference photo/floor-plan uploads.
2.  **Your preferences:** style, colours/materials, storage, budget,
    desired views.
3.  **Must preserve:** doors, windows, columns, plumbing/electrical
    points, and furniture/items to retain.
4.  **Voice or text.**
5.  **Review brief.**

### Landscape form

1.  **Your outdoor area:** front/back/side yard or terrace; approximate
    area.
2.  **Local conditions:** city/climate, sunlight, water availability,
    maintenance tolerance, relevant pet/child needs.
3.  **Features and style:** existing trees/features to retain,
    paths/hardscape, seating, privacy, vegetable/herb garden, preferred
    style.
4.  **Voice or text.**
5.  **Review brief.**

## 4.5 Component requirements

### Project cards

-   Clear title and concise description.
-   Distinct visual/icon cue for new build, interior, and landscaping.
-   Accessible clickable target and keyboard focus.
-   CTA that communicates the next step.

### Voice component

-   Language selector driven by configuration.
-   Explicit consent before recording.
-   Live recording state and elapsed time.
-   Stop/cancel/re-record controls.
-   Upload/transcribing/success/failure states.
-   Transcript correction UI.
-   Clear fallback to text if the provider is unavailable.

### Upload component

-   Accepted file types and maximum size shown before selection.
-   Thumbnail/preview where safe, upload progress, remove/replace
    controls.
-   Private-storage explanation.
-   Useful errors for unsupported/oversized files.
-   Do not render arbitrary SVG/HTML uploads as trusted UI.

### Brief review

-   Separate customer-provided facts, assumptions, and missing values.
-   Editable English brief.
-   Clear unresolved-question list.
-   Approval action disabled while required fields remain unresolved.
-   Preserve transcript and normalized values for traceability.

### Quote component

-   Itemized line items and units/quantities.
-   Subtotal, taxes/fees, discount, total, currency, validity where
    configured.
-   Demo-only label for placeholder rates.
-   Accepted quote snapshot cannot silently change when rates change.

### Payment component

-   Official server-configured UPI/bank instructions.
-   Exact accepted quote total.
-   UTR/reference, transfer date, amount, method, optional proof.
-   Clear statement: payment is manually checked; submission is not
    verification.
-   Never ask for passwords, OTPs, PINs, or complete banking
    credentials.

### Results gallery

-   Responsive grid.
-   `AI Concept` or equivalent label.
-   Brief summary and current status.
-   Zoom/download only after release.
-   Concept-only disclaimer visible near the output.
-   Do not expose provider metadata to customers by default, but retain
    it server-side for traceability.
-   Failure state and retry action where permitted.

### Admin queue

-   Clear status labels, timestamps, project/customer references, and
    next action.
-   Proof preview via signed URL only.
-   Confirm/reject controls require explicit action; rejection requires
    a reason.
-   Release action visible only for eligible projects, but backend
    authorization is still mandatory.
-   Mobile-friendly alternative to wide tables.

## 4.6 Required UI states

-   Idle, recording, uploading, transcribing, transcript ready, speech
    provider unavailable.
-   Brief requires clarification, customer editing, brief approved.
-   Quote ready, quote accepted, payment pending, proof submitted,
    rejected, verified.
-   Generation queued, generating, complete awaiting review,
    failed/retryable, released.
-   Empty project list, no payment records, no generation jobs.
-   Upload error, expired sign-in, unauthorized admin attempt, provider
    rate limit/timeout.
-   Mock mode versus live provider output.

## 4.7 Content and disclaimers

Use plain, non-alarming language near relevant steps:

-   **General:** "These are conceptual design ideas, not construction
    drawings. Have a qualified professional validate dimensions,
    structure, safety, and local regulations before building."
-   **2D plan:** "Illustrative layout only --- not CAD or a construction
    drawing. Dimensions may be approximate."
-   **Interior:** "Visual inspiration only. Existing dimensions,
    structure, electrical/plumbing conditions, and product sizes have
    not been verified."
-   **Landscape:** "Plant selection, local suitability, drainage,
    irrigation, pet/child safety, and maintenance need
    local/professional review."
-   **Payment:** "Your transfer reference is reviewed manually.
    Submission does not mean payment has been verified."
-   **Mock output:** "Demo/mock output --- this result was not produced
    by the live AI provider."

## 4.8 UX acceptance checklist

-   [ ] Primary CTA and all three project cards are visible and usable.
-   [ ] Progress feedback persists through multi-step flows.
-   [ ] Inputs have labels, hints, errors, and keyboard focus.
-   [ ] User can complete each journey without a microphone.
-   [ ] Upload constraints and private-storage messaging are visible.
-   [ ] Brief differentiates facts, assumptions, and missing
    information.
-   [ ] Quote line items and total are easy to inspect.
-   [ ] Payment status clearly explains manual verification.
-   [ ] Results cannot be opened/downloaded before release.
-   [ ] Mobile layout works at 360 px.
-   [ ] Colour is not the sole way status is conveyed.
-   [ ] Every provider/mock failure has a useful next action.

------------------------------------------------------------------------
