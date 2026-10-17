-- Phase 2 / migration 3 of 5: workflow guards, cascades, audit and admin functions.
--
-- These triggers enforce the non-negotiable invariants (CLAUDE.md section 7) inside
-- the database, so they hold even if server code has a bug:
--   * customers cannot change a project's status, approval, or payment decision;
--   * every status change must be an allowed transition (03_APP_FLOW.md);
--   * GENERATING requires a VERIFIED payment for the accepted quote;
--   * RELEASED requires an administrator, a verified payment and generated assets;
--   * accepted quotes are frozen; audit history is append-only.
--
-- "Untrusted" below means the Supabase end-user roles (anon, authenticated).
-- Trusted server code uses service_role. The transaction-local setting app.via is
-- set only inside the SECURITY DEFINER functions below, to mark internal cascades.

-- ---------------------------------------------------------------------------
-- Small shared helpers
-- ---------------------------------------------------------------------------

-- Statuses in which a customer may still edit draft content.
create or replace function public.project_is_editable(p_status text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_status in ('DRAFT', 'TRANSCRIPT_READY', 'BRIEF_REVIEW');
$$;

revoke all on function public.project_is_editable(text) from public, anon;
grant execute on function public.project_is_editable(text) to authenticated, service_role;

create or replace function app_private.transition_allowed(p_from text, p_to text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.project_status_transitions t
    where t.from_status = p_from and t.to_status = p_to
  );
$$;

-- The payment gate: a VERIFIED payment against the project's accepted quote.
create or replace function app_private.project_has_verified_payment(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.payments pay
    join public.quotes q on q.id = pay.quote_id
    where pay.project_id = p_project_id
      and pay.status = 'VERIFIED'
      and q.project_id = p_project_id
      and q.accepted_at is not null
  );
$$;

create or replace function app_private.write_audit(
  p_action     text,
  p_project_id uuid,
  p_payment_id uuid,
  p_actor      uuid,
  p_metadata   jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (action, project_id, payment_id, actor_id, metadata_json)
  values (p_action, p_project_id, p_payment_id, p_actor, coalesce(p_metadata, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create or replace function app_private.projects_guard()
returns trigger
language plpgsql
as $$
declare
  v_untrusted boolean := current_user in ('anon', 'authenticated');
  v_via       text    := coalesce(current_setting('app.via', true), '');
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then
      raise exception 'a project must start in DRAFT' using errcode = '23514';
    end if;
    if new.approved_at is not null then
      raise exception 'a new project cannot already be approved' using errcode = '23514';
    end if;
    if v_untrusted and new.customer_id is distinct from (select auth.uid()) then
      raise exception 'customer_id must be the signed-in user' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.id <> old.id or new.customer_id <> old.customer_id or new.created_at <> old.created_at then
    raise exception 'id, customer_id and created_at are immutable' using errcode = '23514';
  end if;

  if v_untrusted then
    -- Customers may change draft content only: never status, approval or type.
    if new.status is distinct from old.status
       or new.approved_at is distinct from old.approved_at
       or new.project_type is distinct from old.project_type then
      raise exception 'status, approval and project type can only be changed by trusted server code'
        using errcode = '42501';
    end if;
    if not public.project_is_editable(old.status) then
      raise exception 'project is not editable in status %', old.status using errcode = '42501';
    end if;
    return new;
  end if;

  -- Trusted callers.
  if old.approved_at is not null and new.approved_at is distinct from old.approved_at then
    raise exception 'approved_at is write-once' using errcode = '23514';
  end if;

  if new.status is distinct from old.status then
    if not app_private.transition_allowed(old.status, new.status) then
      raise exception 'illegal project status transition % -> %', old.status, new.status
        using errcode = '23514';
    end if;

    case new.status
      when 'BRIEF_APPROVED' then
        if coalesce(btrim(new.english_brief_text), '') = '' then
          raise exception 'a brief cannot be approved without an English brief' using errcode = '23514';
        end if;
        new.approved_at := coalesce(new.approved_at, now());
      when 'QUOTED' then
        if not exists (select 1 from public.quotes q where q.project_id = new.id) then
          raise exception 'a project cannot be QUOTED without a quote' using errcode = '23514';
        end if;
      when 'AWAITING_PAYMENT' then
        if not exists (select 1 from public.quotes q where q.project_id = new.id and q.accepted_at is not null) then
          raise exception 'awaiting payment requires an accepted quote' using errcode = '23514';
        end if;
      when 'PAYMENT_PROOF_SUBMITTED', 'PAYMENT_VERIFIED', 'PAYMENT_REJECTED' then
        if v_via <> 'payment_cascade' then
          raise exception 'payment states change only through a payment submission or an administrator decision'
            using errcode = '42501';
        end if;
      when 'GENERATING' then
        if not app_private.project_has_verified_payment(new.id) then
          raise exception 'generation requires a verified payment' using errcode = '42501';
        end if;
      when 'GENERATION_FAILED' then
        if not exists (select 1 from public.generation_jobs j where j.project_id = new.id and j.status = 'FAILED') then
          raise exception 'GENERATION_FAILED requires a failed generation job' using errcode = '23514';
        end if;
      when 'READY_FOR_REVIEW' then
        if not exists (select 1 from public.generation_jobs j where j.project_id = new.id and j.status = 'SUCCEEDED')
           or not exists (select 1 from public.design_assets a where a.project_id = new.id and a.generation_job_id is not null) then
          raise exception 'READY_FOR_REVIEW requires a succeeded job and generated assets' using errcode = '23514';
        end if;
      when 'RELEASED' then
        if v_via <> 'admin_release' then
          raise exception 'only an administrator can release a project' using errcode = '42501';
        end if;
        if not app_private.project_has_verified_payment(new.id) then
          raise exception 'release requires a verified payment' using errcode = '42501';
        end if;
        if not exists (select 1 from public.design_assets a where a.project_id = new.id and a.generation_job_id is not null) then
          raise exception 'release requires generated assets' using errcode = '23514';
        end if;
      else
        null;
    end case;
  end if;

  return new;
end;
$$;

create trigger trg_10_projects_guard
  before insert or update on public.projects
  for each row execute function app_private.projects_guard();

create or replace function app_private.projects_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev  text := coalesce(current_setting('app.via', true), '');
  v_count integer;
begin
  if new.status is distinct from old.status then
    perform app_private.write_audit(
      'project.status_changed', new.id, null, (select auth.uid()),
      jsonb_build_object('from', old.status, 'to', new.status)
    );

    -- Releasing a project releases its generated deliverables, atomically.
    if new.status = 'RELEASED' then
      perform set_config('app.via', 'release_cascade', true);
      update public.design_assets
         set is_released = true
       where project_id = new.id
         and generation_job_id is not null
         and not is_released;
      get diagnostics v_count = row_count;
      perform set_config('app.via', v_prev, true);
      perform app_private.write_audit(
        'asset.released', new.id, null, (select auth.uid()),
        jsonb_build_object('released_assets', v_count)
      );
    end if;
  end if;
  return null;
end;
$$;

create trigger trg_90_projects_after_update
  after update on public.projects
  for each row execute function app_private.projects_after_update();

-- ---------------------------------------------------------------------------
-- quotes
-- ---------------------------------------------------------------------------
create or replace function app_private.quotes_guard()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if tg_op = 'DELETE' then
    if old.accepted_at is not null then
      raise exception 'an accepted quote cannot be deleted' using errcode = '23514';
    end if;
    return old;
  end if;

  select p.status into v_status from public.projects p where p.id = new.project_id;

  if tg_op = 'INSERT' then
    if v_status is null or v_status not in ('BRIEF_APPROVED', 'QUOTED') then
      raise exception 'quotes can be created only for an approved brief' using errcode = '23514';
    end if;
    if new.accepted_at is not null then
      raise exception 'a quote is accepted by updating it, not by inserting it' using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.accepted_at is not null then
    raise exception 'an accepted quote is frozen' using errcode = '23514';
  end if;
  if new.project_id <> old.project_id or new.created_at <> old.created_at then
    raise exception 'quote project and creation time are immutable' using errcode = '23514';
  end if;
  if new.accepted_at is not null then
    if v_status <> 'QUOTED' then
      raise exception 'a quote can be accepted only while the project is QUOTED' using errcode = '23514';
    end if;
    if new.valid_until is not null and new.valid_until <= now() then
      raise exception 'this quote has expired' using errcode = '23514';
    end if;
    new.accepted_at := now();
  end if;
  return new;
end;
$$;

create trigger trg_10_quotes_guard
  before insert or update or delete on public.quotes
  for each row execute function app_private.quotes_guard();

create or replace function app_private.quotes_after_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.accepted_at is null and new.accepted_at is not null then
    perform app_private.write_audit(
      'quote.accepted', new.project_id, null, (select auth.uid()),
      jsonb_build_object('quote_id', new.id, 'total_amount', new.total_amount,
                         'currency', new.currency, 'pricing_rule_version', new.pricing_rule_version)
    );
  end if;
  return null;
end;
$$;

create trigger trg_90_quotes_after_update
  after update on public.quotes
  for each row execute function app_private.quotes_after_update();

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
create or replace function app_private.payments_guard()
returns trigger
language plpgsql
as $$
declare
  v_untrusted boolean := current_user in ('anon', 'authenticated');
  v_status    text;
  v_owner     uuid;
  v_quote     record;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING_REVIEW' then
      raise exception 'a submitted payment must start as PENDING_REVIEW' using errcode = '42501';
    end if;

    select p.status, p.customer_id into v_status, v_owner
      from public.projects p where p.id = new.project_id;
    if v_status is null then
      raise exception 'project not found' using errcode = '42501';
    end if;
    if v_untrusted and v_owner is distinct from (select auth.uid()) then
      raise exception 'you can submit payments only for your own projects' using errcode = '42501';
    end if;
    if v_status not in ('AWAITING_PAYMENT', 'PAYMENT_REJECTED') then
      raise exception 'payment proof can be submitted only while awaiting payment' using errcode = '23514';
    end if;

    select q.project_id, q.accepted_at, q.currency into v_quote
      from public.quotes q where q.id = new.quote_id;
    if not found or v_quote.project_id <> new.project_id or v_quote.accepted_at is null then
      raise exception 'a payment must reference the accepted quote of the same project' using errcode = '23514';
    end if;
    if v_quote.currency <> new.currency then
      raise exception 'payment currency must match the quote currency' using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE: evidence is immutable; only a pending claim can be decided, once.
  if v_untrusted then
    raise exception 'payments can be changed only by an administrator workflow' using errcode = '42501';
  end if;
  if (new.project_id, new.quote_id, new.amount_claimed, new.currency, new.method,
      new.utr_reference, new.transfer_date, new.proof_storage_path, new.created_at)
     is distinct from
     (old.project_id, old.quote_id, old.amount_claimed, old.currency, old.method,
      old.utr_reference, old.transfer_date, old.proof_storage_path, old.created_at) then
    raise exception 'submitted payment evidence is immutable' using errcode = '23514';
  end if;
  if old.status <> 'PENDING_REVIEW' then
    raise exception 'a payment decision is final' using errcode = '23514';
  end if;
  if new.status = 'PENDING_REVIEW' then
    return new;   -- only audit_note may change on a pending claim
  end if;

  -- A decision (VERIFIED or REJECTED) must name an administrator.
  if not exists (select 1 from public.admin_users a where a.user_id = new.verified_by) then
    raise exception 'a payment decision must be made by an administrator' using errcode = '42501';
  end if;
  new.verified_at := now();

  if new.status = 'VERIFIED' then
    select q.total_amount, q.currency into v_quote from public.quotes q where q.id = new.quote_id;
    if new.confirmed_amount is distinct from v_quote.total_amount or new.currency <> v_quote.currency then
      raise exception 'confirmed amount must equal the accepted quote total; reject the payment instead'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_10_payments_guard
  before insert or update on public.payments
  for each row execute function app_private.payments_guard();

-- Payment events move the project through its payment states, atomically.
create or replace function app_private.payments_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text := coalesce(current_setting('app.via', true), '');
begin
  if tg_op = 'INSERT' then
    perform set_config('app.via', 'payment_cascade', true);
    update public.projects set status = 'PAYMENT_PROOF_SUBMITTED' where id = new.project_id;
    perform set_config('app.via', v_prev, true);
    perform app_private.write_audit(
      'payment.submitted', new.project_id, new.id, (select auth.uid()),
      jsonb_build_object('quote_id', new.quote_id, 'method', new.method,
                         'amount_claimed', new.amount_claimed, 'currency', new.currency)
    );
    return null;
  end if;

  if new.status is distinct from old.status then
    perform set_config('app.via', 'payment_cascade', true);
    if new.status = 'VERIFIED' then
      update public.projects set status = 'PAYMENT_VERIFIED' where id = new.project_id;
      perform app_private.write_audit(
        'payment.verified', new.project_id, new.id, new.verified_by,
        jsonb_build_object('quote_id', new.quote_id, 'confirmed_amount', new.confirmed_amount,
                           'currency', new.currency)
      );
    elsif new.status = 'REJECTED' then
      update public.projects set status = 'PAYMENT_REJECTED' where id = new.project_id;
      perform app_private.write_audit(
        'payment.rejected', new.project_id, new.id, new.verified_by,
        jsonb_build_object('quote_id', new.quote_id, 'reason', new.rejection_reason)
      );
    end if;
    perform set_config('app.via', v_prev, true);
  end if;
  return null;
end;
$$;

create trigger trg_90_payments_after_insert
  after insert on public.payments
  for each row execute function app_private.payments_after_change();
create trigger trg_90_payments_after_update
  after update on public.payments
  for each row execute function app_private.payments_after_change();

-- ---------------------------------------------------------------------------
-- generation_jobs
-- ---------------------------------------------------------------------------
create or replace function app_private.generation_jobs_guard()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if tg_op = 'INSERT' then
    select p.status into v_status from public.projects p where p.id = new.project_id;
    if v_status is distinct from 'GENERATING' then
      raise exception 'a generation job can be created only while the project is GENERATING' using errcode = '23514';
    end if;
    if not app_private.project_has_verified_payment(new.project_id) then
      raise exception 'generation requires a verified payment' using errcode = '42501';
    end if;
    if new.status <> 'QUEUED' then
      raise exception 'a new generation job must start as QUEUED' using errcode = '23514';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.project_id <> old.project_id or new.created_at <> old.created_at
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'job project, creation time and idempotency key are immutable' using errcode = '23514';
  end if;
  if new.attempt_count < old.attempt_count then
    raise exception 'attempt_count cannot decrease' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    if (old.status, new.status) not in
       (('QUEUED', 'RUNNING'), ('QUEUED', 'FAILED'), ('RUNNING', 'SUCCEEDED'), ('RUNNING', 'FAILED')) then
      raise exception 'illegal generation job transition % -> %', old.status, new.status using errcode = '23514';
    end if;
    if new.status = 'RUNNING' then
      new.started_at := coalesce(new.started_at, now());
    elsif new.status in ('SUCCEEDED', 'FAILED') then
      new.completed_at := coalesce(new.completed_at, now());
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_10_generation_jobs_guard
  before insert or update on public.generation_jobs
  for each row execute function app_private.generation_jobs_guard();

create or replace function app_private.generation_jobs_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform app_private.write_audit(
      'generation.requested', new.project_id, null, (select auth.uid()),
      jsonb_build_object('job_id', new.id, 'provider', new.provider)
    );
  elsif new.status is distinct from old.status then
    perform app_private.write_audit(
      'generation.' || lower(new.status), new.project_id, null, (select auth.uid()),
      jsonb_build_object('job_id', new.id, 'provider', new.provider, 'error_code', new.error_code)
    );
  end if;
  return null;
end;
$$;

create trigger trg_90_generation_jobs_after_insert
  after insert on public.generation_jobs
  for each row execute function app_private.generation_jobs_after_change();
create trigger trg_90_generation_jobs_after_update
  after update on public.generation_jobs
  for each row execute function app_private.generation_jobs_after_change();

-- ---------------------------------------------------------------------------
-- design_assets
-- ---------------------------------------------------------------------------
create or replace function app_private.design_assets_guard()
returns trigger
language plpgsql
as $$
declare
  v_untrusted boolean := current_user in ('anon', 'authenticated');
  v_status    text;
  v_owner     uuid;
begin
  if tg_op = 'DELETE' then
    if old.is_released then
      raise exception 'released assets cannot be deleted' using errcode = '23514';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.is_released then
      raise exception 'assets are never created as released' using errcode = '42501';
    end if;
    select p.status, p.customer_id into v_status, v_owner
      from public.projects p where p.id = new.project_id;
    if v_status is null then
      raise exception 'project not found' using errcode = '42501';
    end if;

    if v_untrusted then
      if new.asset_type not in ('REFERENCE', 'PAYMENT_PROOF') then
        raise exception 'customers can add only reference files and payment proof' using errcode = '42501';
      end if;
      if v_owner is distinct from (select auth.uid()) then
        raise exception 'you can add files only to your own projects' using errcode = '42501';
      end if;
      if new.asset_type = 'REFERENCE' and not public.project_is_editable(v_status) then
        raise exception 'reference files can be added only while the project is editable' using errcode = '23514';
      end if;
      if new.asset_type = 'PAYMENT_PROOF' and v_status not in ('AWAITING_PAYMENT', 'PAYMENT_REJECTED') then
        raise exception 'payment proof can be added only while awaiting payment' using errcode = '23514';
      end if;
    elsif new.generation_job_id is not null then
      if not exists (select 1 from public.generation_jobs j
                      where j.id = new.generation_job_id and j.project_id = new.project_id) then
        raise exception 'the generation job belongs to a different project' using errcode = '23514';
      end if;
      if not app_private.project_has_verified_payment(new.project_id) then
        raise exception 'generated assets require a verified payment' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if new.project_id <> old.project_id
     or new.generation_job_id is distinct from old.generation_job_id
     or new.asset_type <> old.asset_type
     or new.storage_path <> old.storage_path
     or new.created_at <> old.created_at then
    raise exception 'asset identity and location are immutable' using errcode = '23514';
  end if;
  if new.is_released is distinct from old.is_released then
    if not (new.is_released
            and not old.is_released
            and coalesce(current_setting('app.via', true), '') = 'release_cascade') then
      raise exception 'is_released can only be set by the release workflow' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_10_design_assets_guard
  before insert or update or delete on public.design_assets
  for each row execute function app_private.design_assets_guard();

-- ---------------------------------------------------------------------------
-- Configuration and administrator-role auditing
-- ---------------------------------------------------------------------------
create or replace function app_private.site_settings_before()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

create trigger trg_10_site_settings_before
  before insert or update on public.site_settings
  for each row execute function app_private.site_settings_before();

create or replace function app_private.config_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  -- NEW is unassigned for DELETE, so pick the row that exists.
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;

  if tg_table_name = 'pricing_rules' then
    perform app_private.write_audit(
      'pricing_rule.changed', null, null, (select auth.uid()),
      jsonb_build_object('operation', tg_op, 'rule_id', v_row.id,
        'project_type', v_row.project_type, 'rule_key', v_row.rule_key,
        'version', v_row.version)
    );
  elsif tg_table_name = 'site_settings' then
    -- The value is deliberately not recorded: only which setting changed.
    perform app_private.write_audit(
      'site_setting.changed', null, null, (select auth.uid()),
      jsonb_build_object('operation', tg_op, 'key', v_row.key, 'version', v_row.version)
    );
  elsif tg_table_name = 'admin_users' then
    perform app_private.write_audit(
      case when tg_op = 'INSERT' then 'admin.granted' else 'admin.revoked' end,
      null, null, (select auth.uid()),
      jsonb_build_object('user_id', v_row.user_id)
    );
  end if;
  return null;
end;
$$;

create trigger trg_90_pricing_rules_audit
  after insert or update or delete on public.pricing_rules
  for each row execute function app_private.config_after_change();
create trigger trg_90_site_settings_audit
  after insert or update or delete on public.site_settings
  for each row execute function app_private.config_after_change();
create trigger trg_90_admin_users_audit
  after insert or delete on public.admin_users
  for each row execute function app_private.config_after_change();

-- ---------------------------------------------------------------------------
-- audit_events is append-only for everyone, including trusted roles.
-- ---------------------------------------------------------------------------
create or replace function app_private.audit_events_block_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only' using errcode = '42501';
end;
$$;

create trigger trg_10_audit_events_no_update_delete
  before update or delete on public.audit_events
  for each row execute function app_private.audit_events_block_change();
create trigger trg_10_audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function app_private.audit_events_block_change();

-- ---------------------------------------------------------------------------
-- Administrator functions (the only way an administrator decides or releases).
-- Each checks the caller is an administrator; the guards above still apply.
-- ---------------------------------------------------------------------------
create or replace function public.admin_verify_payment(
  p_payment_id       uuid,
  p_confirmed_amount numeric,
  p_audit_note       text default null
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
begin
  if not public.is_admin() then
    raise exception 'administrator access required' using errcode = '42501';
  end if;
  update public.payments
     set status = 'VERIFIED',
         confirmed_amount = p_confirmed_amount,
         verified_by = (select auth.uid()),
         audit_note = p_audit_note
   where id = p_payment_id and status = 'PENDING_REVIEW'
   returning * into v_payment;
  if not found then
    raise exception 'payment not found or not awaiting review' using errcode = 'P0002';
  end if;
  return v_payment;
end;
$$;

create or replace function public.admin_reject_payment(
  p_payment_id uuid,
  p_reason     text,
  p_audit_note text default null
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
begin
  if not public.is_admin() then
    raise exception 'administrator access required' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a rejection reason is required' using errcode = '23514';
  end if;
  update public.payments
     set status = 'REJECTED',
         rejection_reason = p_reason,
         verified_by = (select auth.uid()),
         audit_note = p_audit_note
   where id = p_payment_id and status = 'PENDING_REVIEW'
   returning * into v_payment;
  if not found then
    raise exception 'payment not found or not awaiting review' using errcode = 'P0002';
  end if;
  return v_payment;
end;
$$;

create or replace function public.admin_release_project(p_project_id uuid)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.projects;
  v_prev    text := coalesce(current_setting('app.via', true), '');
  v_found   boolean;
begin
  if not public.is_admin() then
    raise exception 'administrator access required' using errcode = '42501';
  end if;
  perform 1 from public.projects where id = p_project_id for update;
  perform set_config('app.via', 'admin_release', true);
  update public.projects set status = 'RELEASED'
   where id = p_project_id and status = 'READY_FOR_REVIEW'
   returning * into v_project;
  -- Capture FOUND now: the PERFORM below would reset it.
  v_found := found;
  perform set_config('app.via', v_prev, true);
  if not v_found then
    raise exception 'project not found or not ready for review' using errcode = 'P0002';
  end if;
  return v_project;
end;
$$;

revoke all on function public.admin_verify_payment(uuid, numeric, text) from public, anon;
revoke all on function public.admin_reject_payment(uuid, text, text)   from public, anon;
revoke all on function public.admin_release_project(uuid)              from public, anon;
grant execute on function public.admin_verify_payment(uuid, numeric, text) to authenticated, service_role;
grant execute on function public.admin_reject_payment(uuid, text, text)   to authenticated, service_role;
grant execute on function public.admin_release_project(uuid)              to authenticated, service_role;

-- Internal helpers are callable only by trusted server code.
revoke all on all functions in schema app_private from public, anon, authenticated;
grant execute on function app_private.transition_allowed(text, text)        to service_role;
grant execute on function app_private.project_has_verified_payment(uuid)    to service_role;
