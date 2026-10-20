-- Phase 5 / migration 7: AI usage ledger and budget guard.
--
-- PURPOSE. Every call to a paid or rate-limited AI provider is recorded here BEFORE it is
-- made, so that (a) one customer cannot run up unlimited calls, and (b) the provider's
-- total spend can never pass a ceiling, even when requests arrive at the same moment.
--
-- DESIGN.
--   * A ledger table, one row per provider call. Rows are never deleted or truncated. Only
--     the outcome (status, reported usage, request id) can change, once, from RESERVED to a
--     final state.
--   * Two functions, executable by trusted server code only (service_role):
--       ai_usage_reserve  checks the per-customer limit and the provider ceiling and inserts a
--                         RESERVED row in ONE transaction, serialized per provider with an
--                         advisory lock, so concurrent requests cannot both squeeze under a limit.
--       ai_usage_finish   records the outcome (SUCCEEDED / FAILED / NOT_SENT).
--   * FAIL CLOSED: a missing, non-numeric (NaN / Infinity), zero or negative limit or amount
--     raises an error and reserves nothing. Waiting for the lock more than 3 seconds also
--     raises an error.
--   * HARD CEILING IN SQL: for Gnani the cumulative ceiling is clamped to 5,000 credits here,
--     whatever the caller passes (keep in step with GNANI_HARD_CEILING_CREDITS in
--     src/lib/providers/config.ts; tests/db/ai-usage.test.ts checks they match).
--   * Conservative accounting: a call counts as the LARGER of its estimate and anything the
--     provider reported, so a finished call is never cheaper than it was reserved at (a
--     failed request may still have been billed, and Gnani reports no usage at all). Only
--     NOT_SENT (the call was never made) is released.
--   * Only administrators can read the ledger from a session; only trusted server code can
--     write. No prompt text, transcript, audio or key is ever stored here.
--   * LIMITATION: this ledger sees only calls made through this application. Credits spent
--     elsewhere (for example in the provider's own dashboard) are invisible to it.
--
-- Error codes raised by ai_usage_reserve:
--   AI001  the customer's own limit for this window is reached (all operations of a provider
--          share one customer limit)
--   AI002  the provider-wide ceiling is reached
--   AI003  too many calls to this provider are already in flight (when a cap is given)
--   22023  a limit, amount or provider/operation/unit combination was missing or invalid
--   55000  not running at READ COMMITTED isolation
--   55P03  the provider lock could not be taken within 3 seconds
--
-- Rollback: supabase/rollbacks/20261018000200_ai_usage.down.sql

create table public.ai_usage (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references auth.users (id) on delete restrict,
  project_id      uuid references public.projects (id) on delete restrict,
  provider        text not null check (provider in ('openrouter', 'gnani')),
  operation       text not null check (operation in ('brief', 'stt', 'tts')),
  model           text check (model is null or length(model) <= 200),
  -- 'request' for providers measured in calls, 'credit' for providers measured in credits.
  unit            text not null check (unit in ('request', 'credit')),
  -- Greater than zero, never NaN or Infinity (NaN sorts above every number in PostgreSQL).
  units_estimated numeric(12, 2) not null check (units_estimated >= 0.01 and units_estimated < 10000000000),
  units_reported  numeric(12, 2) check (units_reported >= 0 and units_reported < 10000000000),
  status          text not null default 'RESERVED'
    check (status in ('RESERVED', 'SUCCEEDED', 'FAILED', 'NOT_SENT')),
  request_id      text check (request_id is null or length(request_id) <= 200),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A provider is measured in one unit, so a credit ceiling cannot be dodged with another unit.
  constraint ai_usage_provider_shape check (
    (provider = 'openrouter' and operation = 'brief' and unit = 'request')
    or (provider = 'gnani' and operation in ('stt', 'tts') and unit = 'credit')
  ),
  -- A reservation has no outcome yet.
  constraint ai_usage_outcome_shape check (
    status <> 'RESERVED' or (units_reported is null and request_id is null)
  )
);

comment on table public.ai_usage is
  'Ledger of AI provider calls (budget guard). Written only by trusted server code; never holds prompts, transcripts, audio or keys.';

-- Every budget-guard query filters on provider and a recent time window (the customer's
-- own hour, the provider's day) or sums one provider's rows for the ceiling. One index
-- serves all of them; EXPLAIN showed a separate per-customer index added nothing
-- (tests/db/index-usage.test.ts). Index-only scan.
create index ai_usage_provider_time_idx
  on public.ai_usage (provider, created_at desc)
  include (unit, status, units_estimated, units_reported);
-- Foreign key lookups: from a project, and from auth.users (deleting a user checks this table).
create index ai_usage_project_idx on public.ai_usage (project_id) where project_id is not null;
create index ai_usage_customer_idx on public.ai_usage (customer_id);

create trigger trg_20_ai_usage_updated_at before update on public.ai_usage
  for each row execute function app_private.set_updated_at();

-- The ledger is append-only apart from recording an outcome once. Never deleted, never truncated.
create or replace function app_private.ai_usage_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'ai_usage rows cannot be deleted or truncated' using errcode = '42501';
  end if;
  if (new.customer_id, new.project_id, new.provider, new.operation, new.unit, new.units_estimated, new.created_at)
     is distinct from
     (old.customer_id, old.project_id, old.provider, old.operation, old.unit, old.units_estimated, old.created_at) then
    raise exception 'ai_usage reservations are immutable' using errcode = '23514';
  end if;
  if old.status <> 'RESERVED' then
    raise exception 'a finished ai_usage record is final' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger trg_10_ai_usage_guard
  before update or delete on public.ai_usage
  for each row execute function app_private.ai_usage_guard();

create trigger trg_10_ai_usage_no_truncate
  before truncate on public.ai_usage
  for each statement execute function app_private.ai_usage_guard();

-- ---------------------------------------------------------------------------
-- Privileges and row level security
-- ---------------------------------------------------------------------------
alter table public.ai_usage enable row level security;

-- Start from nothing: the default privileges would otherwise leave service_role with
-- DELETE and TRUNCATE.
revoke all on public.ai_usage from public, anon, authenticated, service_role;
grant select on public.ai_usage to authenticated;
grant select, insert, update on public.ai_usage to service_role;

-- Customers cannot read the ledger (no screen needs it); administrators can.
create policy ai_usage_select_admin on public.ai_usage
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Reserve: check both limits and record the call, atomically.
--
--   p_units                 what this call is expected to use (requests, or credits); rounded
--                           UP to two decimals
--   p_customer_limit        most units this customer may use per window, across the provider's
--                           operations
--   p_customer_window_minutes  length of that window
--   p_global_limit          most units the provider may use in total in its window. For Gnani
--                           it is clamped to 5,000 credits.
--   p_global_window_minutes the provider-wide window; NULL means cumulative (for ever). Gnani
--                           must be cumulative.
--   p_max_in_flight         when given, the most calls to this provider that may be RESERVED
--                           (started, not yet finished) at once. A reservation older than two
--                           minutes is treated as abandoned for THIS check only; it still counts
--                           towards spend.
-- ---------------------------------------------------------------------------
create or replace function public.ai_usage_reserve(
  p_customer_id              uuid,
  p_project_id               uuid,
  p_provider                 text,
  p_operation                text,
  p_model                    text,
  p_unit                     text,
  p_units                    numeric,
  p_customer_limit           numeric,
  p_customer_window_minutes  integer,
  p_global_limit             numeric,
  p_global_window_minutes    integer default null,
  p_max_in_flight            integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
set lock_timeout = '3s'
as $$
declare
  -- Absolute Gnani budget. Keep equal to GNANI_HARD_CEILING_CREDITS in src/lib/providers/config.ts.
  c_gnani_ceiling constant numeric := 5000;
  v_units        numeric;
  v_global_limit numeric;
  v_used         numeric;
  v_id           uuid;
begin
  -- Fail closed: every limit must be present, finite and sensible.
  if p_customer_id is null or p_provider is null or p_operation is null or p_unit is null
     or p_units is null or p_units in ('NaN'::numeric, 'Infinity'::numeric) or p_units <= 0 or p_units >= 10000000000
     or p_customer_limit is null or p_customer_limit in ('NaN'::numeric, 'Infinity'::numeric) or p_customer_limit <= 0
     or p_customer_window_minutes is null or p_customer_window_minutes <= 0
     or p_global_limit is null or p_global_limit in ('NaN'::numeric, 'Infinity'::numeric) or p_global_limit <= 0
     or (p_global_window_minutes is not null and p_global_window_minutes <= 0)
     or (p_max_in_flight is not null and p_max_in_flight <= 0) then
    raise exception 'usage limits are missing or invalid' using errcode = '22023';
  end if;

  -- A provider is measured in one unit, with fixed operations.
  if not ((p_provider = 'openrouter' and p_operation = 'brief' and p_unit = 'request')
          or (p_provider = 'gnani' and p_operation in ('stt', 'tts') and p_unit = 'credit')) then
    raise exception 'unknown provider, operation or unit' using errcode = '22023';
  end if;

  v_units := ceil(p_units * 100) / 100;
  v_global_limit := p_global_limit;
  if p_provider = 'gnani' then
    -- The Gnani ceiling is cumulative and can never be raised by a caller.
    if p_global_window_minutes is not null then
      raise exception 'the gnani ceiling is cumulative and cannot use a window' using errcode = '22023';
    end if;
    v_global_limit := least(p_global_limit, c_gnani_ceiling);
  end if;

  -- The checks below rely on seeing every committed reservation once the lock is held.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ai_usage_reserve requires READ COMMITTED isolation' using errcode = '55000';
  end if;

  -- One reservation at a time per provider, so two requests cannot both pass the check.
  -- Transaction-level: released at commit or error. Gives up after lock_timeout (3 seconds).
  perform pg_advisory_xact_lock(hashtextextended('ai_usage:' || p_provider, 0));

  if p_max_in_flight is not null then
    select count(*) into v_used
      from public.ai_usage u
     where u.provider = p_provider
       and u.status = 'RESERVED'
       and u.created_at > now() - interval '2 minutes';
    if v_used >= p_max_in_flight then
      raise exception 'too many calls in flight' using errcode = 'AI003';
    end if;
  end if;

  -- All of this provider's operations share the customer's limit.
  select coalesce(sum(greatest(u.units_estimated, coalesce(u.units_reported, 0))), 0) into v_used
    from public.ai_usage u
   where u.customer_id = p_customer_id
     and u.provider = p_provider
     and u.unit = p_unit
     and u.status <> 'NOT_SENT'
     and u.created_at > now() - make_interval(mins => p_customer_window_minutes);
  if v_used + v_units > p_customer_limit then
    raise exception 'customer usage limit reached' using errcode = 'AI001';
  end if;

  select coalesce(sum(greatest(u.units_estimated, coalesce(u.units_reported, 0))), 0) into v_used
    from public.ai_usage u
   where u.provider = p_provider
     and u.unit = p_unit
     and u.status <> 'NOT_SENT'
     and (p_global_window_minutes is null
          or u.created_at > now() - make_interval(mins => p_global_window_minutes));
  if v_used + v_units > v_global_limit then
    raise exception 'provider usage ceiling reached' using errcode = 'AI002';
  end if;

  insert into public.ai_usage (customer_id, project_id, provider, operation, model, unit, units_estimated)
  values (p_customer_id, p_project_id, p_provider, p_operation, p_model, p_unit, v_units)
  returning id into v_id;
  return v_id;
end;
$$;

-- Finish: record the outcome of a reserved call, once.
create or replace function public.ai_usage_finish(
  p_id             uuid,
  p_status         text,
  p_units_reported numeric default null,
  p_request_id     text default null,
  p_model          text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('SUCCEEDED', 'FAILED', 'NOT_SENT') then
    raise exception 'invalid final status' using errcode = '22023';
  end if;
  if p_units_reported is not null
     and (p_units_reported in ('NaN'::numeric, 'Infinity'::numeric) or p_units_reported < 0 or p_units_reported >= 10000000000) then
    raise exception 'invalid reported usage' using errcode = '22023';
  end if;
  update public.ai_usage
     set status = p_status,
         units_reported = p_units_reported,
         request_id = p_request_id,
         model = coalesce(p_model, model)
   where id = p_id and status = 'RESERVED';
  if not found then
    raise exception 'usage record not found or already finished' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.ai_usage_reserve(uuid, uuid, text, text, text, text, numeric, numeric, integer, numeric, integer, integer)
  from public, anon, authenticated;
revoke all on function public.ai_usage_finish(uuid, text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.ai_usage_reserve(uuid, uuid, text, text, text, text, numeric, numeric, integer, numeric, integer, integer)
  to service_role;
grant execute on function public.ai_usage_finish(uuid, text, numeric, text, text)
  to service_role;
