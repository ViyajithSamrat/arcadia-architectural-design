-- Phase 2 / migration 1 of 5: helpers and the administrator role source.
--
-- Decisions (see supabase/README.md):
--   * Administrator rights live in public.admin_users and are checked by
--     public.is_admin(). Nothing about admin status is read from user-editable
--     metadata or from the login token, so a revoked admin loses access at once.
--   * Internal helpers live in the non-exposed schema app_private so they are not
--     reachable as /rest/v1/rpc/* endpoints.

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to service_role;

-- Keeps updated_at current. Used by several tables.
create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Who is an administrator. Rows are created only by trusted server code or by
-- SQL run with database credentials, never by a signed-in user.
create table public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

comment on table public.admin_users is
  'Administrator role source. No end-user policies exist: only trusted server code and SQL run with database credentials can read or change it. Use public.is_admin() to check the caller.';

-- True when the signed-in caller is an administrator. SECURITY DEFINER so it can
-- read admin_users, which end users cannot read directly.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users a where a.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;
