# Phase 4 --- Manual Payment Evidence and Administrator Review

## Objective

Implement the manual/offline payment workflow, secure evidence
submission, and authorized administrator verification/rejection.

## Instructions

Read `CLAUDE.md`, PRD, app flow, backend schema, risk register, TRD, and
the approved execution plan. Follow the existing authentication and
storage architecture.

### Customer workflow

-   Display only the approved payment instructions.
-   Allow a customer to submit payment evidence in supported file
    formats and sizes.
-   Validate file type, size, project ownership, and workflow state on
    the server.
-   Store evidence in private Storage with non-guessable paths.
-   Record a pending-review state and submission metadata.
-   Show that submission is pending review; never describe it as
    verified merely because a file was uploaded.

### Administrator workflow

-   Protect all admin routes and mutations with server-side
    authorization.
-   List only the records an authorized administrator is allowed to
    review.
-   Allow an authorized admin to inspect evidence using a protected
    access mechanism.
-   Provide explicit verify and reject actions with required
    reason/metadata where specified.
-   Validate state transitions on the server and write appropriate audit
    events.
-   Prevent customers from submitting administrator decisions or
    changing payment status via request payloads.

### Security and integrity

-   Verify role and ownership server-side.
-   Prevent cross-customer evidence access.
-   Prevent duplicate submissions or invalid concurrent state
    transitions where practical.
-   Never use a public bucket for payment evidence.
-   Never accept a browser-provided `isPaid`, `verified`, or equivalent
    flag as authoritative.
-   Do not integrate an automated payment gateway unless explicitly
    approved.

### Optional tooling
Use relevant ECC security-review/testing components only if already installed and inspected. Any skill-generated recommendation is subordinate to the project security invariants. Payment screenshots must never be treated as settlement proof, and only authorized server-side admin verification may enable generation.

### Acceptance criteria

-   Customer can submit evidence for their own eligible project.
-   Evidence remains private.
-   Admin-only actions reject unauthorized users.
-   Payment status changes only through authorized server-side actions.
-   Generation remains blocked before verified status.
-   Tests cover unauthorized verification, cross-user access, invalid
    transitions, invalid uploads, and failed submissions.

Do not implement real AI generation or asset release in this phase. Stop
and report.
