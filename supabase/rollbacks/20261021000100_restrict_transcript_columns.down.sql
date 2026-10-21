-- Reverses 20261021000100_restrict_transcript_columns.sql: removes the transcript guard,
-- gives the customer role back INSERT and UPDATE on the three transcript columns (exactly
-- as granted by 20261017000400_rls_and_grants.sql) and removes the source_language default.
-- Existing rows are not touched. The application must then send source_language again
-- when it creates a draft (the code still treats a missing value as 'en').
drop trigger if exists trg_15_projects_transcript_guard on public.projects;
drop function if exists app_private.projects_transcript_guard();

grant insert (source_language, transcript_original, transcript_corrected) on public.projects to authenticated;
grant update (source_language, transcript_original, transcript_corrected) on public.projects to authenticated;

alter table public.projects alter column source_language drop default;
