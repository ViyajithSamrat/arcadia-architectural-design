-- Phase 2 / migration 2 of 5: core tables, constraints and indexes.
--
-- Source: architectural-ai-design-spec/05_BACKEND_SCHEMA.md (tables, columns),
-- 03_APP_FLOW.md (project states and transitions), 02_TRD.md section 2.8.
-- Enumerations use text + CHECK constraints (the spec allows "enum/text check")
-- so values can evolve through a normal migration.
--
-- No rates, prices, payment details, model identifiers or limits are seeded.

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table public.projects (
  id                   uuid primary key default gen_random_uuid(),
  customer_id          uuid not null references auth.users (id) on delete restrict,
  project_type         text not null
    check (project_type in ('EMPTY_PLOT', 'INTERIOR', 'LANDSCAPE')),
  status               text not null default 'DRAFT'
    check (status in (
      'DRAFT', 'TRANSCRIPT_READY', 'BRIEF_REVIEW', 'BRIEF_APPROVED', 'QUOTED',
      'AWAITING_PAYMENT', 'PAYMENT_PROOF_SUBMITTED', 'PAYMENT_REJECTED',
      'PAYMENT_VERIFIED', 'GENERATING', 'GENERATION_FAILED',
      'READY_FOR_REVIEW', 'RELEASED', 'CANCELLED'
    )),
  source_language      text,
  transcript_original  text,
  transcript_corrected text,
  requirements_json    jsonb not null default '{}'::jsonb
    check (jsonb_typeof(requirements_json) = 'object'),
  english_brief_json   jsonb,
  english_brief_text   text,
  approved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Once a brief is approved the approval moment must be on record (03_APP_FLOW guard).
  constraint projects_approval_recorded check (
    status not in (
      'BRIEF_APPROVED', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_PROOF_SUBMITTED',
      'PAYMENT_REJECTED', 'PAYMENT_VERIFIED', 'GENERATING', 'GENERATION_FAILED',
      'READY_FOR_REVIEW', 'RELEASED'
    ) or approved_at is not null
  )
);

comment on table public.projects is
  'One customer request. status is server-controlled: customers cannot change it (see workflow guard triggers).';
comment on column public.projects.approved_at is
  'Moment the customer approved the brief. Replaces the source PDF''s duplicate approved_by_customer_at (see 05_BACKEND_SCHEMA.md).';

-- Allowed project status transitions, taken from 03_APP_FLOW.md section 3.2.
-- PAYMENT_VERIFIED -> CANCELLED is deliberately absent: the spec allows it only
-- "if business policy permits", and refund/cancellation policy is deferred.
create table public.project_status_transitions (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);

insert into public.project_status_transitions (from_status, to_status) values
  ('DRAFT',                   'TRANSCRIPT_READY'),
  ('DRAFT',                   'BRIEF_REVIEW'),
  ('DRAFT',                   'CANCELLED'),
  ('TRANSCRIPT_READY',        'BRIEF_REVIEW'),
  ('TRANSCRIPT_READY',        'CANCELLED'),
  ('BRIEF_REVIEW',            'BRIEF_APPROVED'),
  ('BRIEF_REVIEW',            'CANCELLED'),
  ('BRIEF_APPROVED',          'QUOTED'),
  ('BRIEF_APPROVED',          'CANCELLED'),
  ('QUOTED',                  'AWAITING_PAYMENT'),
  ('QUOTED',                  'CANCELLED'),
  ('AWAITING_PAYMENT',        'PAYMENT_PROOF_SUBMITTED'),
  ('AWAITING_PAYMENT',        'CANCELLED'),
  ('PAYMENT_PROOF_SUBMITTED', 'PAYMENT_VERIFIED'),
  ('PAYMENT_PROOF_SUBMITTED', 'PAYMENT_REJECTED'),
  ('PAYMENT_REJECTED',        'AWAITING_PAYMENT'),
  ('PAYMENT_REJECTED',        'PAYMENT_PROOF_SUBMITTED'),
  ('PAYMENT_REJECTED',        'CANCELLED'),
  ('PAYMENT_VERIFIED',        'GENERATING'),
  ('GENERATING',              'READY_FOR_REVIEW'),
  ('GENERATING',              'GENERATION_FAILED'),
  ('GENERATION_FAILED',       'GENERATING'),
  ('GENERATION_FAILED',       'CANCELLED'),
  ('READY_FOR_REVIEW',        'RELEASED');

-- ---------------------------------------------------------------------------
-- quotes
-- ---------------------------------------------------------------------------
create table public.quotes (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects (id) on delete restrict,
  currency             text not null check (currency ~ '^[A-Z]{3}$'),
  line_items_json      jsonb not null check (jsonb_typeof(line_items_json) = 'array'),
  subtotal             numeric(12, 2) not null check (subtotal >= 0),
  tax_amount           numeric(12, 2) not null default 0 check (tax_amount >= 0),
  discount_amount      numeric(12, 2) not null default 0 check (discount_amount >= 0),
  total_amount         numeric(12, 2) not null check (total_amount >= 0),
  pricing_rule_version text not null check (length(btrim(pricing_rule_version)) > 0),
  valid_until          timestamptz,
  accepted_at          timestamptz,
  created_at           timestamptz not null default now(),
  -- Total = subtotal + taxes/fees - discount (05_BACKEND_SCHEMA.md section 5.12).
  constraint quotes_total_formula check (total_amount = subtotal + tax_amount - discount_amount),
  constraint quotes_valid_window check (valid_until is null or valid_until > created_at)
);

comment on table public.quotes is
  'Server-calculated quotes. An accepted quote is frozen (immutable snapshot).';

-- At most one accepted quote per project.
create unique index quotes_one_accepted_per_project
  on public.quotes (project_id) where accepted_at is not null;

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
create table public.payments (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete restrict,
  quote_id           uuid not null references public.quotes (id) on delete restrict,
  amount_claimed     numeric(12, 2) not null check (amount_claimed > 0),
  currency           text not null check (currency ~ '^[A-Z]{3}$'),
  method             text not null check (method in ('UPI', 'NETBANKING')),
  utr_reference      text not null check (length(btrim(utr_reference)) > 0),
  transfer_date      date not null,
  proof_storage_path text,
  status             text not null default 'PENDING_REVIEW'
    check (status in ('PENDING_REVIEW', 'VERIFIED', 'REJECTED')),
  rejection_reason   text,
  confirmed_amount   numeric(12, 2) check (confirmed_amount > 0),
  verified_by        uuid references auth.users (id) on delete restrict,
  verified_at        timestamptz,
  audit_note         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- A decision always names the administrator and the time (verify AND reject).
  constraint payments_decision_consistent check (
    (status = 'PENDING_REVIEW'
       and verified_by is null and verified_at is null
       and confirmed_amount is null and rejection_reason is null)
    or (status = 'VERIFIED'
       and verified_by is not null and verified_at is not null
       and confirmed_amount is not null and rejection_reason is null)
    or (status = 'REJECTED'
       and verified_by is not null and verified_at is not null
       and rejection_reason is not null and length(btrim(rejection_reason)) > 0)
  ),
  constraint payments_proof_path_in_project check (
    proof_storage_path is null
    or starts_with(proof_storage_path, project_id::text || '/payment-proofs/')
  )
);

comment on table public.payments is
  'Customer payment claims. A submitted claim is evidence, never proof; only an administrator decision (verify/reject) changes status.';
comment on column public.payments.verified_by is
  'Administrator who made the decision. Set for both VERIFIED and REJECTED. Hidden from customers by column grants.';
comment on column public.payments.audit_note is
  'Internal administrator note. Hidden from customers by column grants.';

-- A project has at most one payment awaiting review (prevents duplicate submissions).
create unique index payments_one_pending_per_project
  on public.payments (project_id) where status = 'PENDING_REVIEW';

-- ---------------------------------------------------------------------------
-- generation_jobs
-- ---------------------------------------------------------------------------
create table public.generation_jobs (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete restrict,
  status              text not null default 'QUEUED'
    check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  provider            text not null check (length(btrim(provider)) > 0),
  text_model          text,
  image_model         text,
  prompt_version      text not null check (length(btrim(prompt_version)) > 0),
  prompt_json         jsonb not null default '{}'::jsonb,
  attempt_count       integer not null default 0 check (attempt_count >= 0),
  idempotency_key     text,
  provider_request_id text,
  duration_ms         integer check (duration_ms >= 0),
  usage_json          jsonb,
  cost_amount         numeric(12, 4) check (cost_amount >= 0),
  cost_currency       text check (cost_currency ~ '^[A-Z]{3}$'),
  error_code          text,
  error_summary       text,
  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  constraint generation_jobs_timing check (
    completed_at is null or started_at is null or completed_at >= started_at
  )
);

comment on table public.generation_jobs is
  'Provider calls for design generation. Customers cannot read this table (provider metadata stays server-side).';

-- Duplicate-charge protection: one active job per project, and unique idempotency keys.
create unique index generation_jobs_one_active_per_project
  on public.generation_jobs (project_id) where status in ('QUEUED', 'RUNNING');
create unique index generation_jobs_idempotency
  on public.generation_jobs (project_id, idempotency_key) where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- design_assets
-- ---------------------------------------------------------------------------
create table public.design_assets (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete restrict,
  generation_job_id uuid references public.generation_jobs (id) on delete restrict,
  asset_type        text not null check (asset_type in (
    'REFERENCE', 'PAYMENT_PROOF', 'FLOOR_PLAN_SVG',
    'EXTERIOR_CONCEPT', 'INTERIOR_CONCEPT', 'LANDSCAPE_CONCEPT'
  )),
  storage_path      text not null unique,
  mime_type         text not null check (length(btrim(mime_type)) > 0),
  width             integer check (width > 0),
  height            integer check (height > 0),
  is_released       boolean not null default false,
  created_at        timestamptz not null default now(),
  -- Object paths are <project_id>/<kind>/<file>, tying every file to a project owner.
  constraint design_assets_path_matches_type check (
       (asset_type = 'REFERENCE'
          and starts_with(storage_path, project_id::text || '/references/'))
    or (asset_type = 'PAYMENT_PROOF'
          and starts_with(storage_path, project_id::text || '/payment-proofs/'))
    or (asset_type in ('FLOOR_PLAN_SVG', 'EXTERIOR_CONCEPT', 'INTERIOR_CONCEPT', 'LANDSCAPE_CONCEPT')
          and starts_with(storage_path, project_id::text || '/generated/'))
  ),
  -- Generated assets always come from a job; uploads never do.
  constraint design_assets_job_link check (
    (asset_type in ('FLOOR_PLAN_SVG', 'EXTERIOR_CONCEPT', 'INTERIOR_CONCEPT', 'LANDSCAPE_CONCEPT'))
      = (generation_job_id is not null)
  ),
  -- Only generated deliverables can be released to a customer.
  constraint design_assets_release_only_generated check (
    not is_released
    or asset_type in ('FLOOR_PLAN_SVG', 'EXTERIOR_CONCEPT', 'INTERIOR_CONCEPT', 'LANDSCAPE_CONCEPT')
  )
);

comment on column public.design_assets.is_released is
  'Set only by the release workflow (public.admin_release_project). Never writable by clients.';

-- ---------------------------------------------------------------------------
-- pricing_rules and site_settings (administrator-managed configuration)
-- ---------------------------------------------------------------------------
create table public.pricing_rules (
  id                uuid primary key default gen_random_uuid(),
  project_type      text not null
    check (project_type in ('EMPTY_PLOT', 'INTERIOR', 'LANDSCAPE')),
  rule_key          text not null check (length(btrim(rule_key)) > 0),
  rate              numeric(12, 2) not null check (rate >= 0),
  unit              text not null check (length(btrim(unit)) > 0),
  minimum_charge    numeric(12, 2) not null default 0 check (minimum_charge >= 0),
  included_quantity numeric(12, 2) not null default 0 check (included_quantity >= 0),
  add_on_rate       numeric(12, 2) not null default 0 check (add_on_rate >= 0),
  currency          text not null check (currency ~ '^[A-Z]{3}$'),
  effective_from    timestamptz not null default now(),
  effective_until   timestamptz,
  version           integer not null default 1 check (version >= 1),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pricing_rules_window check (effective_until is null or effective_until > effective_from),
  constraint pricing_rules_version_unique unique (project_type, rule_key, version)
);

comment on table public.pricing_rules is
  'Server-owned pricing. No rates are seeded: real or clearly labelled demo rates are entered by an administrator.';

create table public.site_settings (
  key        text primary key check (length(btrim(key)) > 0),
  value_json jsonb not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  version    integer not null default 1 check (version >= 1)
);

comment on table public.site_settings is
  'Administrator-managed settings (for example payment instructions, supported languages). Never store secrets here. No values are seeded.';

-- ---------------------------------------------------------------------------
-- audit_events (append-only; see the guard migration)
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id            uuid primary key default gen_random_uuid(),
  -- No foreign key on purpose: audit history must outlive a deleted user.
  actor_id      uuid,
  action        text not null check (length(btrim(action)) > 0),
  project_id    uuid references public.projects (id) on delete restrict,
  payment_id    uuid references public.payments (id) on delete restrict,
  "timestamp"   timestamptz not null default now(),
  metadata_json jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata_json) = 'object')
);

comment on table public.audit_events is
  'Append-only history of sensitive actions. Keep metadata minimal and free of secrets.';

-- ---------------------------------------------------------------------------
-- Indexes (05_BACKEND_SCHEMA.md section 5.10, each tied to an expected query)
-- ---------------------------------------------------------------------------
-- customer "My projects" list, and the policy check on projects.customer_id
create index projects_customer_created_idx on public.projects (customer_id, created_at desc);
-- admin queues by workflow state
create index projects_status_updated_idx on public.projects (status, updated_at desc);
-- quotes of a project (customer quote page, policy join)
create index quotes_project_created_idx on public.quotes (project_id, created_at desc);
-- admin payment queue, and a project's payment history
create index payments_status_created_idx on public.payments (status, created_at desc);
create index payments_project_created_idx on public.payments (project_id, created_at desc);
-- foreign key lookup from quote to its payments
create index payments_quote_idx on public.payments (quote_id);
-- admin generation queue, and a project's jobs
create index generation_jobs_project_created_idx on public.generation_jobs (project_id, created_at desc);
create index generation_jobs_status_created_idx on public.generation_jobs (status, created_at desc);
-- results gallery and release checks
create index design_assets_project_released_idx on public.design_assets (project_id, is_released, created_at desc);
-- foreign key lookup from job to its assets
create index design_assets_job_idx on public.design_assets (generation_job_id) where generation_job_id is not null;
-- audit lookups per project and per payment
create index audit_events_project_time_idx on public.audit_events (project_id, "timestamp" desc);
create index audit_events_payment_time_idx on public.audit_events (payment_id, "timestamp" desc);

-- updated_at maintenance
create trigger trg_20_projects_updated_at before update on public.projects
  for each row execute function app_private.set_updated_at();
create trigger trg_20_payments_updated_at before update on public.payments
  for each row execute function app_private.set_updated_at();
create trigger trg_20_pricing_rules_updated_at before update on public.pricing_rules
  for each row execute function app_private.set_updated_at();
