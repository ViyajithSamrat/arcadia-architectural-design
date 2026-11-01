import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EDITABLE_PROJECT_STATUSES, type ProjectType } from "@/lib/db/schema";
import { getOwnedProject } from "@/lib/journeys/service";
import { checkEvidenceFile } from "@/lib/payments/evidence";
import { readImageSize } from "@/lib/providers/images";
import { buildObjectPath, newObjectName, parseObjectPath, PROJECT_FILES_BUCKET } from "@/lib/storage/paths";
import { UPLOAD_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } from "@/lib/uploads/limits";

/**
 * Reference photos and floor plans for interior and landscape projects (PR-010; PRD 1.5).
 *
 * EVERY operation here runs on the CUSTOMER'S OWN session, never the service role, so the
 * database is the authorization and this code is a second check on top of it:
 *   - storage policy project_files_insert_own: a customer may add `references/` objects only to
 *     their own project while it is editable; delete_own_reference the same for removal;
 *   - design_assets policies and guard: a customer may insert only REFERENCE or PAYMENT_PROOF rows,
 *     for their own project, never released, never tied to a job, and may delete only their own
 *     unreleased REFERENCE rows while the project is editable.
 * Both rows and files are therefore private to the owner (and an administrator) at all times: no
 * public bucket, no public URL. A file is shown only through a short-lived signed link created
 * with the owner's session, which the storage policy allows only for that owner.
 *
 * What the server checks itself, before any write:
 *   - the caller owns the project, it is editable, and its type uses references (interior and
 *     landscape; a new build has no reference upload in the specification);
 *   - the project holds fewer than REFERENCES_PER_PROJECT files;
 *   - the file is at most 4 MiB (the request-path limit) and a real JPEG, PNG or WebP by its first bytes, with a readable
 *     size inside sane bounds. The file name and the browser's declared type are never used;
 *   - the object name is a random UUID plus an extension the server derived from the content.
 * Order, so no misleading record is ever left: upload the file, then insert the row; if the row
 * fails the file is removed. On removal, the row goes first, then the file; a file whose removal
 * fails stays private and unreferenced.
 */

type Client = SupabaseClient;

/** The request-path upload limit (src/lib/uploads/limits.ts), enforced by checkEvidenceFile. */
export const REFERENCE_MAX_BYTES = UPLOAD_MAX_BYTES;
export const REFERENCE_REQUEST_MAX_BYTES = UPLOAD_REQUEST_MAX_BYTES;
export const REFERENCES_PER_PROJECT = 6;
export const REFERENCE_MIN_DIMENSION = 64;
export const REFERENCE_MAX_DIMENSION = 12_000;
export const REFERENCE_URL_SECONDS = 300;

/** Project types whose journey takes reference photos or a floor plan. */
export const REFERENCE_PROJECT_TYPES: readonly ProjectType[] = ["INTERIOR", "LANDSCAPE"];

export type ReferenceView = { id: string; url: string | null; width: number | null; height: number | null; createdAt: string };

export type ReferenceResult<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string };
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

const NOT_FOUND = "We could not find that project.";
const GENERIC = "The photo could not be saved. Please try again.";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OwnedProject = NonNullable<Awaited<ReturnType<typeof getOwnedProject>>>;
type Found = { ok: false; message: string } | { ok: true; project: OwnedProject };

async function ownedReferenceProject(supabase: Client, userId: string, projectId: unknown, mustBeEditable: boolean): Promise<Found> {
  if (typeof projectId !== "string" || !ID.test(projectId)) return { ok: false, message: NOT_FOUND };
  const project = await getOwnedProject(supabase, userId, projectId);
  if (!project) return { ok: false, message: NOT_FOUND };
  if (!REFERENCE_PROJECT_TYPES.includes(project.project_type)) return { ok: false, message: "This kind of project does not take reference photos." };
  if (mustBeEditable && !EDITABLE_PROJECT_STATUSES.includes(project.status)) return { ok: false, message: "Photos can only be changed while you are still answering the questions." };
  return { ok: true, project };
}

export type AddReferenceFile = { size: number; arrayBuffer(): Promise<ArrayBuffer> };

export async function addReference(supabase: Client, userId: string, projectId: unknown, file: AddReferenceFile | null): Promise<ReferenceResult<{ asset: { id: string; width: number; height: number; mimeType: string } }>> {
  const found = await ownedReferenceProject(supabase, userId, projectId, true);
  if (!found.ok) return fail(found.message);
  const { project } = found;
  if (!file) return fail("Choose a JPEG, PNG or WebP image.");

  const { data: existing, error: countError } = await supabase.from("design_assets").select("id").eq("project_id", project.id).eq("asset_type", "REFERENCE").limit(REFERENCES_PER_PROJECT);
  if (countError || !Array.isArray(existing)) return fail(GENERIC);
  if (existing.length >= REFERENCES_PER_PROJECT) return fail(`You can keep up to ${REFERENCES_PER_PROJECT} photos. Remove one to add another.`);

  // Size first, so an oversized file is never read; then the real type from the first bytes.
  const checked = await checkEvidenceFile(file);
  if (!checked.ok) return fail(checked.message);
  const size = readImageSize(checked.bytes, checked.image.mime);
  if (!size || size.width < REFERENCE_MIN_DIMENSION || size.height < REFERENCE_MIN_DIMENSION || size.width > REFERENCE_MAX_DIMENSION || size.height > REFERENCE_MAX_DIMENSION) {
    return fail("That image could not be read, or its size is not allowed. Use a normal photo of at least 64 by 64 pixels.");
  }

  const path = buildObjectPath(project.id, "references", newObjectName(checked.image.ext));
  const stored = await supabase.storage.from(PROJECT_FILES_BUCKET).upload(path, checked.bytes, { contentType: checked.image.mime, upsert: false });
  if (stored.error) return fail(GENERIC);

  const { data, error } = await supabase
    .from("design_assets")
    .insert({ project_id: project.id, asset_type: "REFERENCE", storage_path: path, mime_type: checked.image.mime, width: size.width, height: size.height })
    .select("id")
    .single();
  if (error || !data) {
    // No row, so no record points at the file: remove it (the owner's policy allows this while editable).
    await supabase.storage.from(PROJECT_FILES_BUCKET).remove([path]).catch(() => undefined);
    return fail(GENERIC);
  }
  return { ok: true, asset: { id: String((data as { id: unknown }).id), width: size.width, height: size.height, mimeType: checked.image.mime } };
}

/** The project's reference photos with short-lived signed links, newest last. Empty for a project that takes none. */
export async function listReferences(supabase: Client, userId: string, projectId: unknown): Promise<ReferenceView[] | null> {
  const found = await ownedReferenceProject(supabase, userId, projectId, false);
  if (!found.ok) return null;
  const { data, error } = await supabase
    .from("design_assets")
    .select("id, storage_path, width, height, created_at")
    .eq("project_id", found.project.id)
    .eq("asset_type", "REFERENCE")
    .order("created_at", { ascending: true })
    .limit(REFERENCES_PER_PROJECT);
  if (error || !Array.isArray(data)) return null;

  return Promise.all(
    (data as { id: string; storage_path: string; width: number | null; height: number | null; created_at: string }[]).map(async (row) => {
      // Only a path of exactly <this project>/references/<file> is ever signed.
      const parsed = parseObjectPath(row.storage_path);
      let url: string | null = null;
      if (parsed && parsed.kind === "references" && parsed.projectId.toLowerCase() === found.project.id.toLowerCase()) {
        const signed = await supabase.storage.from(PROJECT_FILES_BUCKET).createSignedUrl(row.storage_path, REFERENCE_URL_SECONDS);
        url = signed.error || !signed.data ? null : signed.data.signedUrl;
      }
      return { id: row.id, url, width: row.width, height: row.height, createdAt: row.created_at };
    }),
  );
}

export async function removeReference(supabase: Client, userId: string, projectId: unknown, assetId: unknown): Promise<ReferenceResult> {
  const found = await ownedReferenceProject(supabase, userId, projectId, true);
  if (!found.ok) return fail(found.message);
  if (typeof assetId !== "string" || !ID.test(assetId)) return fail("That photo was not found.");

  const { data: row, error } = await supabase
    .from("design_assets")
    .select("id, storage_path")
    .eq("id", assetId)
    .eq("project_id", found.project.id)
    .eq("asset_type", "REFERENCE")
    .maybeSingle();
  if (error) return fail(GENERIC);
  if (!row) return fail("That photo was not found.");
  const path = String((row as { storage_path: unknown }).storage_path);
  const parsed = parseObjectPath(path);
  if (!parsed || parsed.kind !== "references" || parsed.projectId.toLowerCase() !== found.project.id.toLowerCase()) return fail(GENERIC);

  // The row first: if the file removal then fails, nothing points at a file that is gone.
  const deleted = await supabase.from("design_assets").delete().eq("id", assetId).eq("project_id", found.project.id).eq("asset_type", "REFERENCE").select("id");
  if (deleted.error || !deleted.data || deleted.data.length !== 1) return fail(GENERIC);
  await supabase.storage.from(PROJECT_FILES_BUCKET).remove([path]).catch(() => undefined);
  return { ok: true };
}

/** What the brief records about references: only the ids of the project's own files. */
export async function referenceAssetIds(supabase: Client, projectId: string): Promise<string[]> {
  const { data, error } = await supabase.from("design_assets").select("id").eq("project_id", projectId).eq("asset_type", "REFERENCE").order("created_at", { ascending: true }).limit(REFERENCES_PER_PROJECT);
  if (error || !Array.isArray(data)) return [];
  return (data as { id: string }[]).map((r) => r.id).filter((id) => ID.test(id));
}

