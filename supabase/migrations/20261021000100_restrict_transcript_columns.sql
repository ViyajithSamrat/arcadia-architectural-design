-- R1-C / migration 8: only trusted server code may write the transcript columns.
--
-- Why: the application saves a voice transcript only after verifying a server-signed
-- provenance token (src/lib/voice/provenance.ts), but a signed-in customer could still
-- PATCH transcript_original, transcript_corrected and source_language on their own draft
-- straight through the API with the public key, without any token. That let typed text pass
-- for speech-service output and let a customer claim a source language the brief writer
-- would then receive. These three columns are now written only by the server's trusted
-- (service role) client, after its ownership, status and provenance checks
-- (saveStep in src/lib/journeys/service.ts).
--
-- What changes:
--   1. source_language defaults to 'en' (the value every draft started with), so customers
--      no longer send it when they create a draft.
--   2. The customer role loses INSERT and UPDATE on the three columns. Every other draft
--      column customers could write (requirements_json, the brief text) is unchanged.
--   3. A separate trigger refuses any change to the three columns by anon or authenticated,
--      as defence in depth should a broader grant ever be added. It decides trust the same
--      way as projects_guard (current_user), so the service role and security definer
--      functions are not affected.
-- Existing rows are not changed.
--
-- Rollback: supabase/rollbacks/20261021000100_restrict_transcript_columns.down.sql

alter table public.projects alter column source_language set default 'en';

revoke insert (source_language, transcript_original, transcript_corrected) on public.projects from authenticated;
revoke update (source_language, transcript_original, transcript_corrected) on public.projects from authenticated;

create or replace function app_private.projects_transcript_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.transcript_original is not null
       or new.transcript_corrected is not null
       or new.source_language is distinct from 'en' then
      raise exception 'transcript and source language can only be set by trusted server code'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.transcript_original is distinct from old.transcript_original
     or new.transcript_corrected is distinct from old.transcript_corrected
     or new.source_language is distinct from old.source_language then
    raise exception 'transcript and source language can only be changed by trusted server code'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_15_projects_transcript_guard
  before insert or update on public.projects
  for each row execute function app_private.projects_transcript_guard();
