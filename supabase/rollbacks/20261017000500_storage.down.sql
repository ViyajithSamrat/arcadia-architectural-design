-- Reverses 20261017000500_storage.sql (policies and helper functions).
-- The bucket row itself is NOT deleted here: Supabase blocks direct SQL deletes
-- from storage.buckets / storage.objects ("use the Storage API"). To remove the
-- bucket, empty and delete it from the dashboard or the Storage API afterwards.
-- Until then it stays private, and with the policies gone no signed-in user can
-- read or write it.
drop policy if exists project_files_delete_own_reference on storage.objects;
drop policy if exists project_files_select_admin on storage.objects;
drop policy if exists project_files_select_own on storage.objects;
drop policy if exists project_files_insert_own on storage.objects;
drop function if exists public.storage_object_well_formed(text);
drop function if exists public.storage_object_kind(text);
drop function if exists public.storage_object_project(text);
