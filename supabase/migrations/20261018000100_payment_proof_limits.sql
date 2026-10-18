-- Phase 4 / migration 6: upload restrictions on the private bucket.
--
-- Why: row level security and the server code both check who may upload and when, but
-- neither can stop a signed-in owner from sending a file straight to the Storage API.
-- A limit on the bucket itself is enforced by Storage for every caller, including the
-- service role, so it holds even when the application's own validation is bypassed.
--
-- Values (owner decision, 2026-10-18): images only (JPEG, PNG, WebP), at most 5 MiB.
--
-- Scope: this is ONE bucket shared by references, payment proofs and generated files, so
-- the limit applies to all three. Phase 6 (image generation) must revisit it, for example
-- if generated output is larger than 5 MiB or an SVG floor plan is stored; do that in a
-- new migration, not by editing this one. SVG is deliberately not allowed now because it
-- can carry script and customers can upload to this bucket.
--
-- The matching application check (type by magic bytes, size) is in src/lib/payments/.
-- Keep the two in step: src/lib/payments/evidence.ts holds the same numbers.
--
-- Rollback (restores the previous state: no bucket-level limits; the Storage default
-- of 50 MiB from supabase/config.toml then applies):
--   update storage.buckets
--      set file_size_limit = null, allowed_mime_types = null
--    where id = 'project-files';

update storage.buckets
   set file_size_limit    = 5242880,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'project-files';
