import { randomUUID } from "node:crypto";

/**
 * Object names in the private bucket: <project_id>/<kind>/<file>.
 * The database policies (supabase/migrations/..._storage.sql) parse exactly this
 * shape, so every file is tied to a project owner by its path.
 *
 * File-size and file-type limits are the owner's decision and are not set here.
 */
export const PROJECT_FILES_BUCKET = "project-files";

export const OBJECT_KINDS = ["references", "payment-proofs", "generated"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** Same shape the database accepts (storage_object_project in the storage migration). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One safe path segment: no slashes, no leading dot, no "..". */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EXTENSION = /^[a-z0-9]+$/;

export type ObjectPath = { projectId: string; kind: ObjectKind; fileName: string };

export function buildObjectPath(projectId: string, kind: ObjectKind, fileName: string): string {
  if (!UUID.test(projectId)) throw new Error("projectId must be a UUID");
  if (!OBJECT_KINDS.includes(kind)) throw new Error("unknown object kind");
  if (!FILE_NAME.test(fileName) || fileName.includes("..")) throw new Error("unsafe file name");
  return `${projectId}/${kind}/${fileName}`;
}

/** A non-guessable file name: a random UUID plus a validated extension. */
export function newObjectName(extension: string): string {
  const ext = extension.replace(/^\./, "").toLowerCase();
  if (!EXTENSION.test(ext)) throw new Error("unsafe file extension");
  return `${randomUUID()}.${ext}`;
}

/** Returns null unless the path is exactly <project_id>/<kind>/<file>. */
export function parseObjectPath(path: string): ObjectPath | null {
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  const [projectId, kind, fileName] = parts;
  if (!UUID.test(projectId)) return null;
  if (!(OBJECT_KINDS as readonly string[]).includes(kind)) return null;
  if (!FILE_NAME.test(fileName) || fileName.includes("..")) return null;
  return { projectId, kind: kind as ObjectKind, fileName };
}
