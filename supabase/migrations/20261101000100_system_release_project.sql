-- Automatic release of reviewed-by-rule generation output (migration 12).
--
-- WHY. Until now only an administrator's own session could move a project from READY_FOR_REVIEW to
-- RELEASED (public.admin_release_project checks public.is_admin()). The product now generates
-- concepts automatically after an administrator verifies the payment, and the customer should see
-- finished images without a second manual step. The trusted server worker has no auth.uid(), so it
-- cannot call admin_release_project.
--
-- WHAT. public.system_release_project() is a NEW, separate function for that worker. It releases a
-- project only when the same conditions the application's releaseProject() checks all hold, and it
-- re-checks them inside the database under a row lock:
--   * the project is READY_FOR_REVIEW and has a verified payment for its accepted quote;
--   * no job is QUEUED or RUNNING, at least one job SUCCEEDED, and EVERY generated file belongs to a
--     SUCCEEDED job (a file left by a failed attempt blocks the release);
--   * no SUCCEEDED job is a placeholder: a job whose provider is 'mock' or whose usage_json says
--     mock can never be released by this function. Placeholders still need an administrator, who
--     must acknowledge them through admin_release_project.
-- It uses the existing release path (status RELEASED, then the release cascade that sets is_released),
-- so no guard, policy or trigger is changed or bypassed, and the release is audited.
--
-- WHAT IS NOT CHANGED. admin_release_project, projects_guard, design_assets_guard and every policy
-- are untouched. The owner-held release-invariant test therefore still describes the same database.
--
-- PERMISSIONS. SECURITY DEFINER with an empty search_path. EXECUTE only for service_role: customers,
-- anon and administrators' own sessions cannot call it. Whether the application calls it is a
-- server setting (GENERATION_AUTO_RELEASE); with that off, nothing calls this function and the
-- administrator review step is unchanged.
--
-- Rollback: supabase/rollbacks/20261101000100_system_release_project.down.sql

create or replace function public.system_release_project(p_project_id uuid)
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
  -- Serialize with any other release or retry of this project.
  select * into v_project from public.projects where id = p_project_id for update;
  if not found or v_project.status <> 'READY_FOR_REVIEW' then
    raise exception 'project not found or not ready for review' using errcode = 'P0002';
  end if;

  if not app_private.project_has_verified_payment(p_project_id) then
    raise exception 'release requires a verified payment' using errcode = '42501';
  end if;

  if exists (select 1 from public.generation_jobs j
              where j.project_id = p_project_id and j.status in ('QUEUED', 'RUNNING')) then
    raise exception 'a generation job is still running' using errcode = '23514';
  end if;
  if not exists (select 1 from public.generation_jobs j
                  where j.project_id = p_project_id and j.status = 'SUCCEEDED') then
    raise exception 'there is no succeeded generation job' using errcode = '23514';
  end if;
  if not exists (select 1 from public.design_assets a
                  where a.project_id = p_project_id and a.generation_job_id is not null) then
    raise exception 'there are no generated files to release' using errcode = '23514';
  end if;
  if exists (select 1 from public.design_assets a
               join public.generation_jobs j on j.id = a.generation_job_id
              where a.project_id = p_project_id and j.status <> 'SUCCEEDED') then
    raise exception 'files from a failed or unfinished attempt are attached' using errcode = '23514';
  end if;
  if exists (select 1 from public.generation_jobs j
              where j.project_id = p_project_id and j.status = 'SUCCEEDED'
                and (j.provider = 'mock' or coalesce(j.usage_json ->> 'mock', 'false') = 'true')) then
    raise exception 'placeholder output is released only by an administrator' using errcode = '23514';
  end if;

  perform set_config('app.via', 'admin_release', true);
  update public.projects set status = 'RELEASED'
   where id = p_project_id and status = 'READY_FOR_REVIEW'
   returning * into v_project;
  v_found := found;
  perform set_config('app.via', v_prev, true);
  if not v_found then
    raise exception 'project not found or not ready for review' using errcode = 'P0002';
  end if;

  perform app_private.write_audit(
    'release.automatic', p_project_id, null, null,
    jsonb_build_object('reason', 'succeeded non-placeholder generation')
  );
  return v_project;
end;
$$;

revoke all on function public.system_release_project(uuid) from public, anon, authenticated;
grant execute on function public.system_release_project(uuid) to service_role;
