-- Reverses 20261017000300_workflow_guards.sql: removes every guard/audit trigger and
-- the functions in app_private, plus the public admin functions. Dropping the
-- guards removes the database-level payment and release gates: only for a full reset.
do $$
declare r record;
begin
  for r in
    select c.relname as tbl, t.tgname
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and not t.tgisinternal
      and (t.tgname like 'trg\_10\_%' or t.tgname like 'trg\_90\_%')
  loop
    execute format('drop trigger if exists %I on public.%I', r.tgname, r.tbl);
  end loop;

  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'public' and p.proname in ('admin_verify_payment','admin_reject_payment','admin_release_project','project_is_editable'))
       or (n.nspname = 'app_private' and p.proname <> 'set_updated_at')
  loop
    execute format('drop function if exists %s', r.sig);
  end loop;
end $$;
