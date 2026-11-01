import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sniffImage } from "@/lib/payments/evidence";
import type { ReferenceInput } from "@/lib/providers/images";
import { parseObjectPath, PROJECT_FILES_BUCKET } from "@/lib/storage/paths";

/**
 * The reference photos of one project, read back from private storage for an image provider.
 *
 * Only called from the generation service, after it has checked the administrator, the verified
 * payment and the project, and only when the chosen provider says it accepts reference images.
 * The trusted client reads files; so the project id comes from the already-authorized project,
 * never from the browser, and every file is checked again here:
 *   - the row must be a REFERENCE of THIS project, with a path of exactly
 *     <project_id>/references/<file>;
 *   - the bytes must be a real JPEG, PNG or WebP of at most REFERENCE_MAX_BYTES, whatever the
 *     row, the file name or any declared type says.
 * A file that fails any check is skipped (generation simply goes ahead without it); nothing
 * about it is logged.
 */

/**
 * The bucket limit (5 MiB, migration 6), deliberately not the 4 MiB request-path upload limit
 * (src/lib/uploads/limits.ts): a photo stored before that limit was lowered is still offered.
 */
export const REFERENCE_MAX_BYTES = 5 * 1024 * 1024;
/** Most photos a project may keep, and most that are ever offered to a provider. */
export const REFERENCES_PER_PROJECT = 6;
export const REFERENCES_SENT_MAX = 3;

type Client = SupabaseClient;

export async function loadReferenceInputs(service: Client, projectId: string): Promise<ReferenceInput[]> {
  const { data, error } = await service
    .from("design_assets")
    .select("storage_path")
    .eq("project_id", projectId)
    .eq("asset_type", "REFERENCE")
    .order("created_at", { ascending: true })
    .limit(REFERENCES_SENT_MAX);
  if (error || !Array.isArray(data)) return [];

  const out: ReferenceInput[] = [];
  for (const row of data as { storage_path?: unknown }[]) {
    const path = typeof row.storage_path === "string" ? row.storage_path : "";
    const parsed = parseObjectPath(path);
    if (!parsed || parsed.kind !== "references" || parsed.projectId.toLowerCase() !== projectId.toLowerCase()) continue;
    try {
      const { data: blob, error: downloadError } = await service.storage.from(PROJECT_FILES_BUCKET).download(path);
      if (downloadError || !blob || blob.size === 0 || blob.size > REFERENCE_MAX_BYTES) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sniffed = sniffImage(bytes);
      if (!sniffed || bytes.length > REFERENCE_MAX_BYTES) continue;
      out.push({ mimeType: sniffed.mime, bytes });
    } catch {
      continue;
    }
  }
  return out;
}
