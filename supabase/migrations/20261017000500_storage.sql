-- Phase 2 / migration 5 of 5: private storage.
--
-- One private bucket holds every file (decision: zero-budget project, fewest moving
-- parts). Object names follow  <project_id>/<kind>/<file>  where kind is one of
--   references      customer reference photos / floor plans
--   payment-proofs  customer payment evidence
--   generated       AI deliverables written only by trusted server code
-- so every object is tied to a project owner by its path (05_BACKEND_SCHEMA.md 5.11).
--
-- No file-size or file-type limit is set on the bucket: those values are the owner's
-- decision and have not been supplied. They are enforced by server code in Phase 4
-- and can be added to the bucket here when decided.
--
-- Signed URLs are issued by server code after authorization; there is no public URL.

insert into storage.buckets (id, name, public)
values ('project-files', 'project-files', false)
on conflict (id) do update set public = false;

-- Pure helpers that read the path convention. They never touch tables, so granting
-- them to signed-in users is harmless.
create or replace function public.storage_object_project(p_name text)
returns uuid
language sql
immutable
parallel safe
as $$
  select case
    when split_part(p_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(p_name, '/', 1)::uuid
    else null
  end;
$$;

create or replace function public.storage_object_kind(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select split_part(p_name, '/', 2);
$$;

-- Exactly three segments: <project_id>/<kind>/<file>.
create or replace function public.storage_object_well_formed(p_name text)
returns boolean
language sql
immutable
parallel safe
as $$
  select public.storage_object_project(p_name) is not null
     and array_length(string_to_array(p_name, '/'), 1) = 3
     and length(split_part(p_name, '/', 3)) > 0;
$$;

revoke all on function public.storage_object_project(text)     from public, anon;
revoke all on function public.storage_object_kind(text)        from public, anon;
revoke all on function public.storage_object_well_formed(text) from public, anon;
grant execute on function public.storage_object_project(text)     to authenticated, service_role;
grant execute on function public.storage_object_kind(text)        to authenticated, service_role;
grant execute on function public.storage_object_well_formed(text) to authenticated, service_role;

-- Customers add files only to their own project, in the right state and folder.
create policy project_files_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-files'
    and public.storage_object_well_formed(name)
    and exists (
      select 1 from public.projects p
      where p.id = public.storage_object_project(name)
        and p.customer_id = (select auth.uid())
        and (
          (public.storage_object_kind(name) = 'references'     and public.project_is_editable(p.status))
          or
          (public.storage_object_kind(name) = 'payment-proofs' and p.status in ('AWAITING_PAYMENT', 'PAYMENT_REJECTED'))
        )
    )
  );

-- Owners read their uploads at once; generated files only once released.
create policy project_files_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-files'
    and exists (
      select 1 from public.projects p
      where p.id = public.storage_object_project(name)
        and p.customer_id = (select auth.uid())
    )
    and (
      public.storage_object_kind(name) in ('references', 'payment-proofs')
      or (
        public.storage_object_kind(name) = 'generated'
        and exists (
          select 1 from public.design_assets a
          where a.storage_path = name and a.is_released
        )
      )
    )
  );

-- Administrators can preview everything (for review before release).
create policy project_files_select_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'project-files' and (select public.is_admin()));

-- Customers may remove their own draft reference files (replace = delete + upload).
create policy project_files_delete_own_reference on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-files'
    and public.storage_object_kind(name) = 'references'
    and exists (
      select 1 from public.projects p
      where p.id = public.storage_object_project(name)
        and p.customer_id = (select auth.uid())
        and public.project_is_editable(p.status)
    )
  );

-- No policy lets any signed-in user write to 'generated'. Only service_role (which
-- bypasses RLS) can, and design_assets guards still require a verified payment.
