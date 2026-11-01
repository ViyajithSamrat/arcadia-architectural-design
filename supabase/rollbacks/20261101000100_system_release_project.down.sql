-- Rolls back 20261101000100_system_release_project.sql. Turn GENERATION_AUTO_RELEASE off first: with the
-- function gone, an automatic release attempt fails and the project simply waits for an administrator.
-- Projects already released stay released.
drop function if exists public.system_release_project(uuid);
