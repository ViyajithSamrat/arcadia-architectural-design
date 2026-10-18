-- =============================================================================
-- DEMONSTRATION PRICING. NOT APPROVED. NEVER APPLY TO PRODUCTION.
-- =============================================================================
-- This file is deliberately NOT supabase/seed.sql, so `supabase db reset` and the
-- CLI never apply it on their own. Run it by hand, against a local or throwaway
-- project only:
--
--     psql "$LOCAL_DB_URL" -f supabase/demo/pricing_rules.demo.sql
--
-- Every number below is an UNVERIFIED demonstration assumption (11_DECISIONS: pricing
-- and currency are not yet decided). Most were lifted from the landing-page template's
-- illustrative rates (INR, 18% GST); the rows marked [added] did not exist in the
-- template and were invented only so every quote line has a rate to show.
-- The application reads these rows from pricing_rules like any other rates; the
-- site_settings row 'pricing_mode' = demo makes every quote built from them carry a
-- "Demo rates" label. An administrator replaces them with approved rates and removes
-- the 'pricing_mode' row (or sets it to something other than "demo") to go live.
--
-- Idempotent: re-running does not duplicate rows.
-- =============================================================================

insert into public.site_settings (key, value_json)
values (
  'pricing_mode',
  '{"mode":"demo","note":"Unverified demonstration rates. Not approved commercial pricing."}'::jsonb
)
on conflict (key) do nothing;

insert into public.pricing_rules (project_type, rule_key, rate, unit, currency, version)
values
  -- Shared by all three project types ----------------------------------------
  ('EMPTY_PLOT', 'base_fee',           1500, 'project', 'INR', 1),
  ('INTERIOR',   'base_fee',           1500, 'project', 'INR', 1),
  ('LANDSCAPE',  'base_fee',           1500, 'project', 'INR', 1),
  -- Tax, as a percentage of the subtotal (template: 18% GST) -----------------
  ('EMPTY_PLOT', 'tax_percent',          18, 'percent', 'INR', 1),
  ('INTERIOR',   'tax_percent',          18, 'percent', 'INR', 1),
  ('LANDSCAPE',  'tax_percent',          18, 'percent', 'INR', 1),
  -- New build on an empty plot -----------------------------------------------
  ('EMPTY_PLOT', 'layout_per_floor',   1200, 'floor',   'INR', 1),
  ('EMPTY_PLOT', 'exterior_view',       600, 'view',    'INR', 1),
  ('EMPTY_PLOT', 'interior_view',       450, 'view',    'INR', 1),
  ('EMPTY_PLOT', 'garden_concept',     1500, 'concept', 'INR', 1),
  -- Interior refresh ----------------------------------------------------------
  ('INTERIOR',   'room_concept',       1100, 'room',    'INR', 1),
  ('INTERIOR',   'room_view',           250, 'view',    'INR', 1),  -- [added]
  ('INTERIOR',   'material_sheet',      900, 'sheet',   'INR', 1),
  -- Landscaping ---------------------------------------------------------------
  ('LANDSCAPE',  'site_concept',       2400, 'set',     'INR', 1),
  ('LANDSCAPE',  'concept_view',        400, 'view',    'INR', 1),  -- [added]
  ('LANDSCAPE',  'planting_per_block',  600, 'block of 500 sq ft', 'INR', 1),
  ('LANDSCAPE',  'seating_concept',     800, 'concept', 'INR', 1)
on conflict (project_type, rule_key, version) do nothing;
