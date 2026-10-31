-- Reverses 20261022000100_ai_usage_images.sql: the ledger goes back to briefs and Gnani speech only.
-- It refuses to run while any image row exists: ledger rows are never deleted (see migration 7),
-- so those rows would break the restored constraints. Keep the rows and leave migration 9 applied.

do $$
begin
  if exists (select 1 from public.ai_usage where operation = 'image' or unit = 'image') then
    raise exception 'ai_usage holds image rows; they cannot be removed, so migration 9 cannot be rolled back' using errcode = '23514';
  end if;
end
$$;

alter table public.ai_usage drop constraint ai_usage_provider_shape;
alter table public.ai_usage drop constraint ai_usage_unit_check;
alter table public.ai_usage drop constraint ai_usage_operation_check;

alter table public.ai_usage add constraint ai_usage_operation_check
  check (operation in ('brief', 'stt', 'tts'));
alter table public.ai_usage add constraint ai_usage_unit_check
  check (unit in ('request', 'credit'));
alter table public.ai_usage add constraint ai_usage_provider_shape check (
  (provider = 'openrouter' and operation = 'brief' and unit = 'request')
  or (provider = 'gnani' and operation in ('stt', 'tts') and unit = 'credit')
);

-- The function of migration 7, restored.
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

revoke all on function public.ai_usage_reserve(uuid, uuid, text, text, text, text, numeric, numeric, integer, numeric, integer, integer)
  from public, anon, authenticated;
grant execute on function public.ai_usage_reserve(uuid, uuid, text, text, text, text, numeric, numeric, integer, numeric, integer, integer)
  to service_role;
