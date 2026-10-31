import { AuthError, authErrorResponse } from "@/lib/auth/errors";
import { requireUser } from "@/lib/auth/guards";
import { referenceLimiter } from "@/lib/references/limiter";
import { addReference, REFERENCE_REQUEST_MAX_BYTES } from "@/lib/references/service";
import { isAllowedOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * POST /api/projects/[id]/references: the project owner adds one reference photo (multipart: `file`).
 *
 * A Route Handler, like /api/payments, so the size limit applies to this route alone and is checked
 * before the body is read (Server Actions accept only 1 MB unless raised for every action).
 * The file goes to PRIVATE storage through the owner's own session, so the storage and table
 * policies authorize it; nothing the browser sends decides an owner, a path or a type. Nothing
 * here is logged: no file name, no image.
 */

const json = (body: object, status: number, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const problem = (code: string, message: string, status: number, headers: Record<string, string> = {}) => json({ ok: false, error: { code, message } }, status, headers);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isAllowedOrigin(request)) return problem("BAD_ORIGIN", "Request not allowed.", 403);

  // Refuse before reading anything: the declared size must be present and within the limit.
  const declared = Number(request.headers.get("content-length"));
  if (!request.headers.has("content-length") || !Number.isFinite(declared) || declared < 0) return problem("LENGTH_REQUIRED", "The request size was not declared.", 411);
  if (declared > REFERENCE_REQUEST_MAX_BYTES) return problem("TOO_LARGE", "The photo is too large. It must be 5 MB or smaller.", 413);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return problem("UNSUPPORTED", "Send the photo as a form.", 415);

  let supabase;
  let userId: string;
  try {
    supabase = await createSupabaseServerClient();
    userId = (await requireUser(supabase)).id;
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    throw error;
  }

  // Keyed by the signed-in user's id from the session, never by anything the browser sent.
  const slot = referenceLimiter().acquire(userId);
  if (!slot.ok) {
    return problem("RATE_LIMITED", "Too many uploads in a short time. Wait a moment and try again.", 429, { "Retry-After": String(slot.retryAfterSeconds) });
  }
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return problem("BAD_REQUEST", "That request was not valid.", 400);
    }
    const { id } = await params;
    const file = form.get("file");
    const result = await addReference(supabase, userId, id, file instanceof File ? file : null);
    if (!result.ok) return json({ ok: false, message: result.message }, 422);
    return json({ ok: true, asset: result.asset }, 201);
  } finally {
    slot.release();
  }
}
