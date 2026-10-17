-- Phase 2 / migration 4 of 5: row level security and privileges.
--
-- Principles (05_BACKEND_SCHEMA.md section 5.11, CLAUDE.md section 7):
--   * Deny by default: every table has RLS enabled and end-user roles start with no
--     privileges. anon (not signed in) is granted nothing at all.
--   * Customers can read only their own records. They can write only draft content,
--     a pending payment claim and their own reference/payment-proof files.
--   * Customers can never write status, approval, decisions, release flags or jobs;
--     the workflow guard triggers also enforce this independently of these policies.
--   * Administrators (public.is_admin()) get read access to everything and manage
--     pricing rules and site settings. Verifying, rejecting and releasing go only
--     through the admin_* functions.
--   * service_role (trusted server code) bypasses RLS; the guard triggers still apply.
--
-- Policies call (select auth.uid()) / (select public.is_admin()) so the planner
-- evaluates them once per statement instead of once per row.

alter table public.admin_users               enable row level security;
alter table public.project_status_transitions enable row level security;
alter table public.projects                  enable row level security;
alter table public.quotes                    enable row level security;
alter table public.payments                  enable row level security;
alter table public.generation_jobs           enable row level security;
alter table public.design_assets             enable row level security;
alter table public.pricing_rules             enable row level security;
alter table public.site_settings             enable row level security;
alter table public.audit_events              enable row level security;

-- ---------------------------------------------------------------------------
-- Privileges: start from nothing for end-user roles, then grant precisely.
-- (Supabase grants broad default privileges on new tables; RLS alone would be the
-- only barrier. Removing them leaves two independent layers.)
-- ---------------------------------------------------------------------------
revoke all on
  public.admin_users, public.project_status_transitions, public.projects,
  public.quotes, public.payments, public.generation_jobs, public.design_assets,
  public.pricing_rules, public.site_settings, public.audit_events
from anon, authenticated;

grant all on
  public.admin_users, public.project_status_transitions, public.projects,
  public.quotes, public.payments, public.generation_jobs, public.design_assets,
  public.pricing_rules, public.site_settings, public.audit_events
to service_role;

-- admin_users, project_status_transitions: no end-user access whatsoever.

-- projects: read own; create a draft; edit draft content columns only.
grant select on public.projects to authenticated;
grant insert (customer_id, project_type, source_language, transcript_original,
              transcript_corrected, requirements_json, english_brief_json, english_brief_text)
  on public.projects to authenticated;
grant update (source_language, transcript_original, transcript_corrected,
              requirements_json, english_brief_json, english_brief_text)
  on public.projects to authenticated;

-- quotes: read only (created and accepted by trusted server code).
grant select on public.quotes to authenticated;

-- payments: read the customer-safe columns (NOT verified_by or audit_note);
-- insert a pending claim.
grant select (id, project_id, quote_id, amount_claimed, currency, method, utr_reference,
              transfer_date, proof_storage_path, status, rejection_reason,
              confirmed_amount, verified_at, created_at, updated_at)
  on public.payments to authenticated;
grant insert (project_id, quote_id, amount_claimed, currency, method, utr_reference,
              transfer_date, proof_storage_path)
  on public.payments to authenticated;

-- generation_jobs, audit_events: privileges exist, but policies allow administrators only.
grant select on public.generation_jobs to authenticated;
grant select on public.audit_events    to authenticated;

-- design_assets: read what policies allow; add own uploads; remove own draft references.
grant select, delete on public.design_assets to authenticated;
grant insert (project_id, asset_type, storage_path, mime_type, width, height)
  on public.design_assets to authenticated;

-- pricing_rules, site_settings: policies allow administrators only.
grant select, insert, update, delete on public.pricing_rules to authenticated;
grant select, insert, update, delete on public.site_settings to authenticated;

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create policy projects_select_own on public.projects
  for select to authenticated
  using (customer_id = (select auth.uid()));

create policy projects_select_admin on public.projects
  for select to authenticated
  using ((select public.is_admin()));

create policy projects_insert_own on public.projects
  for insert to authenticated
  with check (customer_id = (select auth.uid()) and status = 'DRAFT' and approved_at is null);

create policy projects_update_own_draft on public.projects
  for update to authenticated
  using (customer_id = (select auth.uid()) and public.project_is_editable(status))
  with check (customer_id = (select auth.uid()) and public.project_is_editable(status));

-- ---------------------------------------------------------------------------
-- quotes
-- ---------------------------------------------------------------------------
create policy quotes_select_own on public.quotes
  for select to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = quotes.project_id and p.customer_id = (select auth.uid())
  ));

create policy quotes_select_admin on public.quotes
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
create policy payments_select_own on public.payments
  for select to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = payments.project_id and p.customer_id = (select auth.uid())
  ));

create policy payments_select_admin on public.payments
  for select to authenticated
  using ((select public.is_admin()));

create policy payments_insert_own_pending on public.payments
  for insert to authenticated
  with check (
    status = 'PENDING_REVIEW'
    and exists (
      select 1 from public.projects p
      where p.id = payments.project_id
        and p.customer_id = (select auth.uid())
        and p.status in ('AWAITING_PAYMENT', 'PAYMENT_REJECTED')
    )
  );

-- ---------------------------------------------------------------------------
-- generation_jobs: administrators only (provider metadata is not for customers)
-- ---------------------------------------------------------------------------
create policy generation_jobs_select_admin on public.generation_jobs
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- design_assets
-- ---------------------------------------------------------------------------
-- Owners see their uploads at once, but generated deliverables only after release.
create policy design_assets_select_own on public.design_assets
  for select to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = design_assets.project_id and p.customer_id = (select auth.uid())
    )
    and (asset_type in ('REFERENCE', 'PAYMENT_PROOF') or is_released)
  );

create policy design_assets_select_admin on public.design_assets
  for select to authenticated
  using ((select public.is_admin()));

create policy design_assets_insert_own_upload on public.design_assets
  for insert to authenticated
  with check (
    asset_type in ('REFERENCE', 'PAYMENT_PROOF')
    and not is_released
    and generation_job_id is null
    and exists (
      select 1 from public.projects p
      where p.id = design_assets.project_id and p.customer_id = (select auth.uid())
    )
  );

create policy design_assets_delete_own_draft_reference on public.design_assets
  for delete to authenticated
  using (
    asset_type = 'REFERENCE'
    and not is_released
    and exists (
      select 1 from public.projects p
      where p.id = design_assets.project_id
        and p.customer_id = (select auth.uid())
        and public.project_is_editable(p.status)
    )
  );

-- ---------------------------------------------------------------------------
-- Administrator-managed configuration and read-only history
-- ---------------------------------------------------------------------------
create policy pricing_rules_admin_all on public.pricing_rules
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy site_settings_admin_all on public.site_settings
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy audit_events_select_admin on public.audit_events
  for select to authenticated
  using ((select public.is_admin()));
