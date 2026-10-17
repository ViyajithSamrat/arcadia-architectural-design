-- Reverses 20261017000100_helpers_and_admin.sql. Removes the admin list.
drop function if exists public.is_admin();
drop table if exists public.admin_users;
drop function if exists app_private.set_updated_at();
drop schema if exists app_private;
