-- Reverses 20261018000200_ai_usage.sql. Drops the usage ledger and its functions.
-- This discards the recorded AI usage history, so the budget guard starts from zero
-- again (including the cumulative Gnani spend): only roll back when no provider budget is
-- being enforced, or export the rows first. Dropping the table also drops its triggers
-- (updated_at, guard, no-truncate), indexes and policy; the function signatures below are
-- unchanged by the revision of migration 7.
drop function if exists public.ai_usage_finish(uuid, text, numeric, text, text);
drop function if exists public.ai_usage_reserve(uuid, uuid, text, text, text, text, numeric, numeric, integer, numeric, integer, integer);
drop table if exists public.ai_usage;
drop function if exists app_private.ai_usage_guard();
