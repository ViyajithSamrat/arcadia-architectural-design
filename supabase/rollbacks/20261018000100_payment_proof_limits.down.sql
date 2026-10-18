-- Reverses 20261018000100_payment_proof_limits.sql: removes the bucket-level size and type
-- limits, which restores the state after the storage migration (no bucket limits; the
-- Storage default of 50 MiB from supabase/config.toml then applies).
-- Existing files are not touched.
update storage.buckets
   set file_size_limit = null,
       allowed_mime_types = null
 where id = 'project-files';
