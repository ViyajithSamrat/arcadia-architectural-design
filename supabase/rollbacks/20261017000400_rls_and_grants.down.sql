-- Reverses 20261017000400_rls_and_grants.sql.
-- Drops every policy on the ten application tables and disables RLS. Table grants
-- are left revoked (the safe state); re-grant deliberately if you really want
-- the tables open. Review before running anywhere that holds real data.
do $$
declare
  p record;
  t text;
begin
  for p in
    select policyname, tablename from pg_policies where schemaname = 'public'
      and tablename in ('admin_users','projects','project_status_transitions','quotes','payments',
                        'generation_jobs','design_assets','pricing_rules','site_settings','audit_events')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
  foreach t in array array['admin_users','projects','project_status_transitions','quotes','payments',
                           'generation_jobs','design_assets','pricing_rules','site_settings','audit_events']
  loop
    execute format('alter table public.%I disable row level security', t);
  end loop;
end $$;
