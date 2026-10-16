# 10. Handoff and Post-PoC Hardening

Do not promote the PoC to a production service without a dedicated
hardening phase.

1.  Run usability and speech-quality tests with real customer voices
    across target languages/dialects; quantify errors for names,
    dimensions, room counts, and local terminology.
2.  Engage architectural professionals to validate the layout generator
    and determine whether a parametric CAD/BIM engine is needed.
3.  Introduce a payment gateway only if desired, with verified webhooks
    and reconciliation; retain manual review as an independently audited
    option.
4.  Add durable asynchronous generation jobs, idempotent retries,
    quotas/spend limits, model/provider evaluation, observability, and
    customer notifications.
5.  Complete privacy notice, consent, retention/deletion, tax, refund,
    and commercial-terms review.
6.  Conduct threat modelling, authorization/RLS review, load testing,
    accessibility checks, and backup/restore tests.
7.  Add versioned revisions and explicit "architect-approved" workflow
    if outputs will be represented as professional deliverables.
8.  Review retention and deletion policies for transcripts, reference
    photos, payment proofs, and generated assets.
9.  Validate provider terms, data processing, geographic handling, rate
    limits, and current API/model capabilities before commercial launch.

------------------------------------------------------------------------
