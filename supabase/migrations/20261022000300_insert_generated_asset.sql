-- Checked write path for generated design assets (stale-job late-write race).
--
-- WHY. A generation request that an administrator cleared as stale may still be running. When its
-- provider finally answers it could upload files and insert design_assets rows on a job that is
-- already FAILED. The design_assets_guard() trigger cannot refuse that write, because the owner-held
-- release-invariant test (tests/db/release-invariant.test.ts) deliberately inserts a leftover asset on a
-- FAILED job as the same role, so the trigger is NOT changed here.
--
-- WHAT. public.insert_generated_asset() is the only write path the application uses for generated
-- assets. In one transaction it locks the job row FOR SHARE and requires, together:
--   * the job exists and belongs to the project;
--   * the job is RUNNING (so a FAILED, SUCCEEDED or QUEUED job is refused);
--   * the project is GENERATING;
--   * the project has a verified payment.
-- FOR SHARE conflicts with the UPDATE that moves the job out of RUNNING. So an in-flight insert makes the
-- stale clearing wait until the insert commits, and an insert that starts after the clearing committed
-- sees FAILED and is refused. Several inserts for the same RUNNING job still run in parallel.
--
-- SCOPE (honest limit). This binds callers of the function. The trigger still allows a direct INSERT by
-- the service role or a superuser on a non-RUNNING job; the application never does that, and
-- releaseProject refuses files whose job did not succeed.
--
-- PERMISSIONS. SECURITY DEFINER with an empty search_path; EXECUTE only for service_role.
-- Rollback: supabase/rollbacks/20261022000300_insert_generated_asset.down.sql

create or replace function public.insert_generated_asset(
  p_project_id uuid,
  p_job_id     uuid,
  p_asset_type text,
  p_storage_path text,
  p_mime_type  text,
  p_width      integer default null,
  p_height     integer default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_project uuid;
  v_job_status  text;
  v_status      text;
  v_id          uuid;
begin
  if p_project_id is null or p_job_id is null then
    raise exception 'a project and a generation job are required' using errcode = '23514';
  end if;
  if p_asset_type is null or p_asset_type not in ('FLOOR_PLAN_SVG', 'EXTERIOR_CONCEPT', 'INTERIOR_CONCEPT', 'LANDSCAPE_CONCEPT') then
    raise exception 'not a generated asset type' using errcode = '23514';
  end if;

  -- FOR SHARE: until this transaction ends, nobody can move the job out of RUNNING.
  select j.project_id, j.status into v_job_project, v_job_status
    from public.generation_jobs j where j.id = p_job_id for share;
  if v_job_project is distinct from p_project_id then
    raise exception 'the generation job belongs to a different project' using errcode = '23514';
  end if;
  if v_job_status <> 'RUNNING' then
    raise exception 'generated assets can be added only to a running generation job' using errcode = '23514';
  end if;

  select p.status into v_status from public.projects p where p.id = p_project_id;
  if v_status is distinct from 'GENERATING' then
    raise exception 'generated assets can be added only while the project is GENERATING' using errcode = '23514';
  end if;
  if not app_private.project_has_verified_payment(p_project_id) then
    raise exception 'generated assets require a verified payment' using errcode = '42501';
  end if;

  insert into public.design_assets (project_id, generation_job_id, asset_type, storage_path, mime_type, width, height)
  values (p_project_id, p_job_id, p_asset_type, p_storage_path, p_mime_type, p_width, p_height)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.insert_generated_asset(uuid, uuid, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.insert_generated_asset(uuid, uuid, text, text, text, integer, integer)
  to service_role;
