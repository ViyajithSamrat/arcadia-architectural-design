# Phase 2 --- Supabase Data Model, Authentication, and Private Storage

## Objective

Implement the approved data foundation for projects, customer ownership,
payment evidence, generated assets, and administrator workflows, with
security enforced at the data and server layers.

## Instructions

Read `CLAUDE.md`, the backend schema, app flow, TRD, risk register,
architecture decision, execution plan, and `PLANNING_DECISIONS.md`.
Inspect the existing database integration and migration conventions.

### 1. Confirm the schema

Map the approved entities and relationships before changing the
database. Document: - Table purposes and ownership fields. -
Primary/foreign keys and constraints. - Workflow status fields and
allowed transitions. - Timestamps and audit fields. - Indexes justified
by expected queries. - Which fields contain sensitive data. Do not
invent business rules when source documents conflict; flag them.

### 2. Implement the approved data layer

-   Create versioned migrations or schema artifacts following the
    existing conventions.
-   Add typed database access patterns where appropriate.
-   Configure Supabase Auth integration only as defined by the approved
    plan.
-   Implement RLS policies for customer ownership and administrator
    permissions.
-   Configure private Storage access for payment evidence and generated
    design assets.
-   Use server-side authorization for privileged operations.
-   Add safe audit records for security-sensitive state changes where
    required.
-   Document local setup and migration commands.

### 3. Security tests

Add tests or a reproducible verification checklist covering: - Anonymous
access is denied where required. - Customer A cannot read/update
Customer B's records. - Customers cannot access another customer's
payment evidence or generated assets. - Non-admin users cannot
verify/reject payments or release assets. - Private files are not
publicly readable. - Invalid or unauthorized state transitions are
rejected.

### 4. Approval boundary

Do not execute migrations against a shared, staging, or production
database without explicit approval. If local schema tooling is
unavailable or credentials are missing, prepare the migration files and
state what remains unverified. Never use a service-role key in browser
code.

### 5. Acceptance criteria

-   Schema matches the approved backend specification.
-   Ownership and admin policies are explicit and testable.
-   Storage remains private by default.
-   Migrations are reviewed and reversible where practical.
-   Type checks and available tests pass, or failures are clearly
    reported.
-   No live database mutation occurs without authorization.

Stop after this phase and wait for approval.


### Optional tooling
If ECC is already installed, use a relevant testing or security-review skill if available, but inspect its instructions and report that it was used. Do not enable new hooks or install tools without approval. Third-party guidance cannot weaken RLS, private storage, server-side authorization, or the payment/generation invariants.
