-- Rolls back 20261022000300_insert_generated_asset.sql. The application then has no checked write
-- path for generated assets, so deploy the previous application code first.
drop function if exists public.insert_generated_asset(uuid, uuid, text, text, text, integer, integer);
