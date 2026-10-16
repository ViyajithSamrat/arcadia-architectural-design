# Phase 6 --- Image/Concept Generation and Controlled Asset Release

## Objective

Implement the approved conceptual-design generation workflow, strictly
gated by verified payment and protected by administrator-controlled
asset release.

## Prerequisites

Do not begin until: - Payment verification is implemented and tested. -
Ownership and administrator authorization are implemented. - Private
storage and release controls are in place. - The chosen image-generation
provider/model capability is verified. - The owner has approved any
potentially paid API use and supplied required credentials.

If any prerequisite is missing, do not bypass it. Complete independent
preparation or report the blocker.

## Implementation requirements

1.  Build a server-side generation entry point.
2.  Re-check user authentication, project ownership, payment
    verification, workflow state, and request eligibility on every
    generation request.
3.  Reject generation before verified payment regardless of frontend
    state.
4.  Protect against duplicate/concurrent requests and handle provider
    timeouts/failures.
5.  Validate prompt inputs and constrain untrusted model outputs.
6.  Store generated files in private Storage using controlled paths and
    metadata.
7.  Keep assets inaccessible to customers until an authorized
    administrator releases them.
8.  Enforce release authorization on the server and through appropriate
    Storage/data policies.
9.  Ensure a customer cannot access another customer's output.
10. Show clear generation/review/release statuses and useful failure
    messages.
11. Mark all outputs as conceptual/illustrative and not
    construction-ready.
12. Do not claim support for CAD/BIM, code compliance, engineering
    validation, or construction documentation.
13. Use mocks in automated tests; never allow mock success to mark real
    payment verified.

### Optional tooling
If ECC security-review/testing components are available, use them to inspect authorization and asset-access boundaries. A design skill may influence presentation but cannot alter server-side generation gates, private-by-default storage, or admin-only release. Do not invoke live paid image generation without explicit approval.

## Acceptance criteria

-   Unverified payment always blocks generation.
-   Verified payment is necessary but not sufficient if other
    eligibility rules apply.
-   Unauthorized users cannot trigger or inspect another project's
    generation.
-   Generated assets remain private before release.
-   Only an authorized admin can release assets.
-   Customers can retrieve only their own released assets.
-   Provider errors do not leak secrets or corrupt project state.
-   Tests cover each security invariant and key failure path.

Do not deploy or make paid live API calls without explicit approval.
Stop after this phase.
