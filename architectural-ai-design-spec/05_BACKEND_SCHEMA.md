# 5. BACKEND SCHEMA --- Data Model and Persistence

## 5.1 Schema conventions

-   UUID primary keys.
-   `created_at` and `updated_at` timestamps where applicable.
-   Foreign keys and appropriate indexes.
-   Enumerated status values or database constraints matching
    application enums.
-   Server-side authorization checks on every sensitive operation.
-   RLS and private storage policies.
-   Store structured requirements as JSONB where the shape differs by
    project type, but keep security-critical statuses, ownership,
    monetary values, and foreign keys in typed columns.
-   Use decimal-safe arithmetic for currency (Postgres `numeric`, or
    integer minor units with a clearly defined currency exponent).
-   Do not store bank login information.
-   Audio retention must be explicit; delete raw audio after successful
    transcription unless the customer has consented to retention.

## 5.2 Entity relationship overview

``` mermaid
erDiagram
    AUTH_USERS ||--o{ PROJECTS : owns
    PROJECTS ||--o{ QUOTES : has
    PROJECTS ||--o{ PAYMENTS : receives
    QUOTES ||--o{ PAYMENTS : references
    PROJECTS ||--o{ GENERATION_JOBS : runs
    GENERATION_JOBS ||--o{ DESIGN_ASSETS : produces
    PROJECTS ||--o{ DESIGN_ASSETS : contains
    PROJECTS ||--o{ AUDIT_EVENTS : records
    PAYMENTS ||--o{ AUDIT_EVENTS : records
    SITE_SETTINGS ||--o{ PRICING_RULES : configures
```

The `AUTH_USERS` and `SITE_SETTINGS` entities above are conceptual;
Supabase Auth owns its user table, and the exact settings representation
is an implementation decision.

## 5.3 `projects`

Stores project identity, type, state, transcripts, structured
requirements, and brief approval.

  ---------------------------------------------------------------------------
  Column                      Suggested type          Notes
  --------------------------- ----------------------- -----------------------
  `id`                        `uuid` PK               Generated UUID

  `customer_id`               `uuid` FK to auth user  Owner; immutable except
                                                      controlled admin
                                                      process

  `project_type`              enum/text check         `EMPTY_PLOT`,
                                                      `INTERIOR`, `LANDSCAPE`

  `status`                    enum/text check         Server-controlled
                                                      workflow state

  `source_language`           `text`                  Selected language code

  `transcript_original`       `text` nullable         Raw STT result; retain
                                                      only as required

  `transcript_corrected`      `text` nullable         Customer-corrected
                                                      transcript

  `requirements_json`         `jsonb`                 Validated
                                                      project-type-specific
                                                      requirements

  `english_brief_json`        `jsonb` nullable        Structured validated
                                                      brief

  `english_brief_text`        `text` nullable         Editable professional
                                                      English brief

  `approved_at`               `timestamptz` nullable  Moment the customer
                                                      approved the brief.
                                                      Set only by the
                                                      server on the
                                                      `BRIEF_APPROVED`
                                                      transition.

  `created_at`                `timestamptz`           Default now

  `updated_at`                `timestamptz`           Updated on mutation
  ---------------------------------------------------------------------------

**Duplicate field resolved:** The source PDF lists both `approved_at` and
`approved_by_customer_at` for `projects`. Only the customer approves a
brief, so the two would always hold the same moment. This document
previously allowed consolidating them if the semantics were documented;
they are consolidated into the single `approved_at` column, whose meaning
is stated in the table above. If a separate administrator approval is ever
added, introduce a new column with a distinct name rather than reusing
this one. The converted PDF text (`architectural-ai-design-poc-4day-plan.md`)
is left unchanged as the source record.

**Recommended additional columns (implementation detail):** `title`,
`cancelled_at`, `last_error_code`, and `schema_version` if they improve
UX/traceability. Do not add them without clear use.

## 5.4 `quotes`

Stores the quote breakdown and accepted snapshot.

  ------------------------------------------------------------------------
  Column                   Suggested type          Notes
  ------------------------ ----------------------- -----------------------
  `id`                     `uuid` PK

  `project_id`             `uuid` FK → projects

  `currency`               `text`                  ISO currency code,
                                                   selected by business

  `line_items_json`        `jsonb`                 Immutable itemized
                                                   breakdown on acceptance

  `subtotal`               `numeric(12,2)`         Currency-safe precision
                                                   appropriate to
                                                   configured currency

  `tax_amount`             `numeric(12,2)`

  `discount_amount`        `numeric(12,2)`         Approved/configured
                                                   discount

  `total_amount`           `numeric(12,2)`         Server-calculated

  `pricing_rule_version`   `text` or `uuid`        Version/snapshot of
                                                   rules used

  `valid_until`            `timestamptz` nullable  Optional quote validity

  `accepted_at`            `timestamptz` nullable  Customer acceptance
                                                   timestamp
  ------------------------------------------------------------------------

**Rules:** Browser does not determine final amounts. Persist a frozen
breakdown/rule version when accepted. The source PDF does not define a
final currency or actual rates; both require business configuration.
Demo placeholder rates must be clearly labelled.

## 5.5 `payments`

Stores offline payment claims and admin verification/rejection.

  -----------------------------------------------------------------------
  Column                  Suggested type          Notes
  ----------------------- ----------------------- -----------------------
  `id`                    `uuid` PK

  `project_id`            `uuid` FK → projects

  `quote_id`              `uuid` FK → quotes      Accepted quote
                                                  reference

  `amount_claimed`        `numeric(12,2)`         Customer-submitted
                                                  claim; untrusted until
                                                  verified

  `currency`              `text`                  Must match
                                                  quote/business rules

  `method`                enum/text check         `UPI` or `NETBANKING`

  `utr_reference`         `text`                  Validate length/format
                                                  reasonably; do not
                                                  treat as proof by
                                                  itself

  `transfer_date`         `date` or `timestamptz` Product decision based
                                                  on required time
                                                  precision

  `proof_storage_path`    `text` nullable         Private object path,
                                                  never a public URL

  `status`                enum/text check         Pending/submitted,
                                                  verified, rejected

  `rejection_reason`      `text` nullable         Required for rejection

  `verified_by`           `uuid` nullable         Authorized admin user

  `verified_at`           `timestamptz` nullable

  `audit_note`            `text` nullable         Minimal operational
                                                  note

  `created_at`            `timestamptz`

  `updated_at`            `timestamptz`
  -----------------------------------------------------------------------

**Recommended implementation detail:** Add `confirmed_amount`, as the
source workflow explicitly requires the admin to record the confirmed
amount. Consider a separate append-only audit record for each status
change rather than relying only on mutable payment columns.

## 5.6 `generation_jobs`

Tracks provider calls, prompts, status, attempts, and failure details.

  ---------------------------------------------------------------------------------
  Column                  Suggested type          Notes
  ----------------------- ----------------------- ---------------------------------
  `id`                    `uuid` PK

  `project_id`            `uuid` FK → projects

  `status`                enum/text check         Queued/running/succeeded/failed
                                                  or mapped workflow state

  `provider`              `text`                  Actual provider or `mock`

  `text_model`            `text` nullable         Brief model when relevant

  `image_model`           `text` nullable         Image model when relevant

  `prompt_version`        `text`                  Versioned template identifier

  `prompt_json`           `jsonb`                 Sanitized prompt/metadata; avoid
                                                  unnecessary sensitive data

  `attempt_count`         `integer`               Non-negative

  `error_code`            `text` nullable         Stable internal code

  `error_summary`         `text` nullable         Safe diagnostic summary

  `created_at`            `timestamptz`

  `started_at`            `timestamptz` nullable

  `completed_at`          `timestamptz` nullable
  ---------------------------------------------------------------------------------

**Recommended implementation detail:** Add `idempotency_key`,
`provider_request_id`, `duration_ms`, `usage_json`, and
`cost_amount`/`cost_currency` when the provider returns those values.
These improve retry safety and spend tracking.

## 5.7 `design_assets`

Tracks reference/generated deliverables and release state.

  -----------------------------------------------------------------------
  Column                  Suggested type          Notes
  ----------------------- ----------------------- -----------------------
  `id`                    `uuid` PK

  `project_id`            `uuid` FK → projects

  `generation_job_id`     `uuid` FK →             Reference to producing
                          generation_jobs         job
                          nullable

  `asset_type`            enum/text check         E.g. reference,
                                                  floor-plan SVG,
                                                  exterior concept,
                                                  interior concept,
                                                  landscape concept,
                                                  payment proof

  `storage_path`          `text`                  Private bucket object
                                                  path

  `mime_type`             `text`                  Validate before use

  `width`                 `integer` nullable      Image dimensions where
                                                  applicable

  `height`                `integer` nullable      Image dimensions where
                                                  applicable

  `is_released`           `boolean`               Must be controlled by
                                                  authorized server logic

  `created_at`            `timestamptz`
  -----------------------------------------------------------------------

**Recommended implementation detail:** Add `uploaded_by`,
`file_size_bytes`, `checksum`, `original_filename_safe`,
`metadata_json`, and a retention/deletion field if required. Never trust
client-set `is_released`.

## 5.8 `pricing_rules` and `site_settings`

The source PDF allows either/both to store configurable rates and
settings. A clean implementation can separate concerns:

### `pricing_rules` (suggested)

-   `id`, `project_type`, `rule_key`, `rate`, `unit`, `minimum_charge`,
    `included_quantity`, `add_on_rate`, `currency`, `effective_from`,
    `effective_until`, `version`, `is_active`, timestamps.
-   Optional project-type/rule JSON only where a relational
    representation becomes unwieldy.
-   All rate changes must be auditable or versioned.
-   Only authorized admin can change rules.

### `site_settings` (suggested)

-   `key`, `value_json`, `updated_by`, `updated_at`, `version`.
-   Store official UPI/bank instructions, supported languages, model
    IDs, tax configuration, policy copy, upload limits, and demo/live
    configuration as appropriate.
-   Protect payment destination settings from customer modification.
-   Do not store secrets in ordinary settings JSON; use secret
    management/environment configuration for credentials.

The exact columns and whether tax settings live in `pricing_rules` or
`site_settings` are implementation choices. Keep rate and
payment-destination authority server-side.

## 5.9 `audit_events`

Append-only history for sensitive actions.

  ------------------------------------------------------------------------------
  Column                  Suggested type          Notes
  ----------------------- ----------------------- ------------------------------
  `id`                    `uuid` PK

  `actor_id`              `uuid` nullable         Auth user or system actor

  `action`                `text`                  E.g. payment
                                                  submitted/verified/rejected,
                                                  generation started/failed,
                                                  asset released, pricing
                                                  changed

  `project_id`            `uuid` nullable FK

  `payment_id`            `uuid` nullable FK

  `timestamp`             `timestamptz`           Default now

  `metadata_json`         `jsonb`                 Minimal non-secret data;
                                                  include reason/amount/version
                                                  as appropriate
  ------------------------------------------------------------------------------

Use append-only application permissions. Normal application code should
not update or delete past audit events. Avoid storing bank credentials
or unnecessary raw proof/audio content in audit metadata.

## 5.10 Indexes and constraints (proposed)

-   `projects(customer_id, created_at DESC)`.
-   `projects(status, updated_at DESC)`.
-   `quotes(project_id, created_at DESC)`.
-   `payments(status, created_at DESC)`.
-   `payments(project_id, created_at DESC)`.
-   `generation_jobs(project_id, created_at DESC)`.
-   `generation_jobs(status, created_at DESC)`.
-   `design_assets(project_id, is_released, created_at DESC)`.
-   `audit_events(project_id, timestamp DESC)` and
    `audit_events(payment_id, timestamp DESC)`.
-   Check constraints for non-negative counts/amounts, allowed enums,
    and sensible timestamps.
-   Foreign keys should prevent orphaned quotes, payments, jobs, and
    assets.
-   Prevent client mutation of protected status columns through database
    policies and server-side service functions.

## 5.11 Row Level Security and storage policies

Policy goals, not copy-paste SQL: - A customer can select/update only
their own projects and allowed draft fields. - A customer cannot set
project/payment/generation/release statuses arbitrarily. - A customer
can view only their own quote/payment status. - A customer cannot read
private payment proof or generated asset objects before authorized
access. - An admin role is validated server-side for sensitive
operations; do not rely on a user-editable metadata flag. - Storage
object paths must be tied to project ownership and checked on the
server. - Signed URLs are short-lived and created only after
authorization. - Service-role access is restricted to trusted server
code and never exposed to the client.

**Important:** Final RLS SQL must be implemented and tested against the
actual Supabase Auth schema and role mechanism; this document is not a
substitute for validating policy behavior.

## 5.12 Pricing model

Source formula:

``` text
Subtotal =
  Base fee
  + Area component
  + Room/zone component
  + Extra-view component
  + Optional add-ons

Total =
  Subtotal
  + Configured taxes/fees
  - Approved discount
```

Potential variables: - **Empty plot:** plot area, proposed built-up
area, floors, room count, requested views. - **Interior:** area or
number of rooms, selected rooms, style/detail tier, views,
reference-image count. - **Landscape:** area, zone count, views,
complexity/maintenance tier.

Store rate, unit, `minimum_charge`, `included_quantity`, `add_on_rate`,
currency, tax configuration, and effective date. Quote lines must
explain the calculation. Use decimal-safe arithmetic. Never invent or
hard-code production rates into UI components.

------------------------------------------------------------------------
