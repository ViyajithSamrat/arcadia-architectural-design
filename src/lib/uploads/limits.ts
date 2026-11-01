/**
 * Upload limits for files that travel in a request body (payment evidence and reference
 * photos). Shared by the browser forms and the server checks so the two cannot drift.
 *
 * Vercel Functions refuse request bodies above 4.5 MB, so a 4 MiB file plus the multipart
 * framing stays under it. The private bucket's own limit (5 MiB, migration
 * 20261018000100_payment_proof_limits.sql) is looser and stays the outer bound; files the
 * server writes itself (generated images) are not limited by this module.
 */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** How the limit is written in messages for the customer. */
export const UPLOAD_MAX_LABEL = "4 MB";
/** Room for the multipart framing around a file of the maximum size. */
export const UPLOAD_FORM_OVERHEAD_BYTES = 64 * 1024;
export const UPLOAD_REQUEST_MAX_BYTES = UPLOAD_MAX_BYTES + UPLOAD_FORM_OVERHEAD_BYTES;
