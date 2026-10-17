-- Reverses 20261017000200_core_tables.sql. DESTROYS ALL APPLICATION DATA in these tables.
drop table if exists public.audit_events;
drop table if exists public.site_settings;
drop table if exists public.pricing_rules;
drop table if exists public.design_assets;
drop table if exists public.generation_jobs;
drop table if exists public.payments;
drop table if exists public.quotes;
drop table if exists public.project_status_transitions;
drop table if exists public.projects;
