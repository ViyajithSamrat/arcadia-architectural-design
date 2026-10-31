-- Serializes the stale clearing's project move against the creation of a new generation job.
--
-- THE RACE. clearStaleJob ends an interrupted job, cleans up, then moves the project from GENERATING
-- to GENERATION_FAILED. A startGeneration that RESUMES a project already in GENERATING creates a new
-- job without changing the project row. Re-reading "is there an active job?" in the application and
-- then updating is two statements: a job created between them was missed, and the clearing then failed
-- the fresh run's project. Locking only the clearing side cannot fix it, because the job INSERT never
-- looked at the project row's lock state before deciding the project was GENERATING.
--
-- THE PROTOCOL (both sides take the same row lock, on the PROJECT row):
--   * creating a job: generation_jobs_guard() reads the project's status FOR KEY SHARE, before it
--     decides. It is the weakest lock that conflicts with the one below; it does not conflict with an
--     ordinary status UPDATE (FOR NO KEY UPDATE), so the normal claim and finish transitions are
--     unaffected, and concurrent job inserts for one project do not block each other.
--   * ending an interrupted generation: end_interrupted_generation() locks the project FOR UPDATE, then
--     checks, under that lock, that the project is still the one the caller saw and has no active job,
--     and only then moves it to GENERATION_FAILED, all in one transaction.
-- So exactly one of two things happens. If the job insert took its lock first, the clearing waits for
-- that transaction, then sees the committed job and leaves the project alone ('ACTIVE_JOB'). If the
-- clearing took its lock first, the job insert waits, then (after the commit) re-reads the status under
-- its lock, sees GENERATION_FAILED and is refused, so no active job is ever attached to a failed project.
--
-- LOCK ORDER. Project row, then (inside the clearing) nothing else is locked; the job insert takes the
-- project lock first and then its own new rows; insert_generated_asset takes the job row, then needs the
-- project for its foreign key, but the clearing never takes a job-row lock while holding the project, so
-- there is no cycle. The function is idempotent: a repeat finds the project no longer GENERATING.
--
-- generation_jobs_guard() below is the original function with exactly one change: the project status
-- read in the INSERT branch carries FOR KEY SHARE. Everything else is byte-for-byte the same logic.
-- PERMISSIONS: SECURITY DEFINER, empty search_path, EXECUTE for service_role only.
-- Rollback: supabase/rollbacks/20261022000400_serialize_stale_clearing.down.sql

create or replace function app_private.generation_jobs_guard()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if tg_op = 'INSERT' then
    -- FOR KEY SHARE: takes part in the project-row lock protocol described at the top of this migration.
    select p.status into v_status from public.projects p where p.id = new.project_id for key share;
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

-- Result codes: 'MOVED' (the project is now GENERATION_FAILED), 'NOT_FOUND', 'PROJECT_CHANGED' (no longer
-- GENERATING, or its updated_at differs from the one the caller read) and 'ACTIVE_JOB' (a QUEUED or
-- RUNNING job exists). Only 'MOVED' changed anything.
create or replace function public.end_interrupted_generation(
  p_project_id uuid,
  p_expect_updated_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status  text;
  v_updated timestamptz;
begin
  if p_project_id is null then
    raise exception 'a project is required' using errcode = '23514';
  end if;

  -- The lock the job INSERT also takes (as KEY SHARE): see the top of this migration.
  select p.status, p.updated_at into v_status, v_updated
    from public.projects p where p.id = p_project_id for update;
  if not found then
    return 'NOT_FOUND';
  end if;
  if v_status <> 'GENERATING' or (p_expect_updated_at is not null and v_updated is distinct from p_expect_updated_at) then
    return 'PROJECT_CHANGED';
  end if;
  -- Read under the lock: a job insert that held its lock first has committed by now and is visible.
  if exists (select 1 from public.generation_jobs j where j.project_id = p_project_id and j.status in ('QUEUED', 'RUNNING')) then
    return 'ACTIVE_JOB';
  end if;

  update public.projects set status = 'GENERATION_FAILED' where id = p_project_id;
  return 'MOVED';
end;
$$;

revoke all on function public.end_interrupted_generation(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.end_interrupted_generation(uuid, timestamptz) to service_role;
