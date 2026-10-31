-- Rolls back 20261022000400_serialize_stale_clearing.sql: removes the function and restores the original
-- generation_jobs_guard() from 20261017000300_workflow_guards.sql (no lock on the project row).
-- Deploy the previous application code first: it must not call end_interrupted_generation().
drop function if exists public.end_interrupted_generation(uuid, timestamptz);

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
