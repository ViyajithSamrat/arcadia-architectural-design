# Phase 7 --- End-to-End QA, Demo Readiness, and Handoff

## Objective

Verify that the approved prototype works as an end-to-end demonstrable
workflow, document limitations, and prepare a reliable demo without
weakening security.

## Instructions

Read `CLAUDE.md`, demo script, handoff/hardening document, risk
register, PRD, execution plan, and requirements traceability matrix.

### 1. Test the full workflow

Run and document: - Project-type selection and requirements capture. -
Brief creation and review. - Quote display. - Payment instruction
display and evidence submission. - Admin review and
verification/rejection. - Generation blocked before verification. -
Generation after authorized verification when the provider is
configured. - Private storage before asset release. - Admin release. -
Customer access only to their own released assets. - Error, retry,
missing-credential, and provider-failure states.

### 2. Security regression checks

Explicitly test: - Cross-user record access. - Cross-user file access. -
Unauthorized admin actions. - Forged payment-status payloads. - Direct
API calls that bypass frontend restrictions. - Asset access before
release. - Invalid workflow transitions. - Secret exposure in client
bundles, logs, and Git-tracked files.

Do not claim a security property is verified unless a test or clear
policy inspection supports it.

### 3. Quality checks

Run the existing project scripts for linting, type checking, unit tests,
integration tests, and production build where available. Do not invent
scripts or results. Clearly report checks that cannot run and why.

### 4. Demo and handoff

-   Follow the documented demo script.
-   Distinguish live provider calls from mocks.
-   List required environment variable names, not their values.
-   Document setup, startup, testing, and troubleshooting steps.
-   Record known limitations, open risks, and production-hardening
    tasks.
-   Update requirement traceability with actual statuses and evidence.
-   Do not mark incomplete items as done.

### 5. Acceptance criteria

-   Main demo path is repeatable.
-   Critical security tests pass or remaining failures are clearly
    identified as blockers.
-   No secrets are committed.
-   Build/test results are accurately documented.
-   Setup and known limitations are clear to another developer.

Do not deploy to production or incur new paid service usage without
explicit approval. Report readiness and wait for the owner's decision.


### Optional QA skills
If gstack is installed and visible, consider `/review` and `/qa` for supplemental review/browser QA. If ECC testing/security-review skills are installed, use relevant ones as supplemental checks. Do not report a skill as used unless it was actually invoked; do not treat a skill's conclusion as a substitute for recording real test commands and results.
