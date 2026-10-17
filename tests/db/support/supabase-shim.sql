-- TEST-ONLY. A minimal stand-in for the parts of Supabase that the migrations rely on.
-- It is NOT part of the product and is never applied to a real project. It exists so
-- the database security rules can be exercised in an in-process Postgres engine.
--
-- What it imitates:  roles anon / authenticated / service_role, auth.users, auth.uid(),
-- the storage.buckets / storage.objects tables, and Supabase's broad default
-- privileges on new objects in the public schema.
-- What it cannot prove: Supabase's real Auth and Storage services behave the same.

create role anon          nologin noinherit;
create role authenticated nologin noinherit;
create role service_role  nologin noinherit bypassrls;

create schema auth;
create table auth.users (
  id    uuid primary key,
  email text
);

-- Same logic as Supabase's auth.uid(): the signed-in user's id from the request claims.
create function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants broad default privileges on new public objects; the migrations
-- deliberately remove them, so the stand-in must start from the same baseline.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now()
);
create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to service_role;
grant select on storage.buckets to authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
