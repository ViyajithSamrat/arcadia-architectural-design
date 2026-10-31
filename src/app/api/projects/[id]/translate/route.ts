import { AuthError } from "@/lib/auth/errors";
import { requireUser } from "@/lib/auth/guards";
import { isAllowedOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { getTranslationMode } from "@/lib/translation/mode";
import { TRANSLATION_OFF_MESSAGE, TRANSLATION_UNAVAILABLE_MESSAGE, translateForProject } from "@/lib/translation/service";
import { translateLimiter } from "@/lib/voice/rate-limit";

/**
 * POST /api/projects/[id]/translate: the project owner sends their reviewed transcript, the
 * original transcript and its provenance token (JSON), and gets back an English suggestion to
 * review. Nothing is stored and nothing here is logged: no transcript, translation or header.
 * In live mode only; otherwise "off" or "unavailable", never a mock translation.
 */

/** Two transcripts of at most 2,000 characters (up to 4 bytes each in UTF-8), the token and JSON framing. */
const MAX_BODY_BYTES = 24 * 1024;

const problem = (code: string, message: string, status: number, headers: Record<string, string> = {}) =>
  Response.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isAllowedOrigin(request)) return problem("BAD_ORIGIN", "Request not allowed.", 403);

  const mode = getTranslationMode();
  if (mode.kind === "off") return problem("TRANSLATION_OFF", TRANSLATION_OFF_MESSAGE, 404);
  if (mode.kind !== "live") return problem("TRANSLATION_UNAVAILABLE", TRANSLATION_UNAVAILABLE_MESSAGE, 503);

  const declared = Number(request.headers.get("content-length"));
  if (!request.headers.has("content-length") || !Number.isFinite(declared) || declared < 0) return problem("LENGTH_REQUIRED", "The request size was not declared.", 411);
  if (declared > MAX_BODY_BYTES) return problem("TOO_LARGE", "The text is too long to translate.", 413);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return problem("UNSUPPORTED", "Send the text as JSON.", 415);

  let supabase;
  let userId: string;
  try {
    supabase = await createSupabaseServerClient();
    userId = (await requireUser(supabase)).id;
  } catch (error) {
    if (error instanceof AuthError) return problem(error.code, error.message, error.status);
    throw error;
  }

  // Keyed by the signed-in user's id from the session, never by anything the browser sent.
  const slot = translateLimiter().acquire(userId);
  if (!slot.ok) {
    return problem(slot.reason === "rate" ? "RATE_LIMITED" : "BUSY", "Too many translation requests. Wait a moment and try again.", 429, {
      "Retry-After": String(slot.retryAfterSeconds),
    });
  }
  try {
    let body: Record<string, unknown>;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) return problem("TOO_LARGE", "The text is too long to translate.", 413);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
      body = parsed as Record<string, unknown>;
    } catch {
      return problem("BAD_REQUEST", "That request was not valid.", 400);
    }

    let service;
    try {
      service = createSupabaseServiceClient();
    } catch {
      return problem("TRANSLATION_UNAVAILABLE", TRANSLATION_UNAVAILABLE_MESSAGE, 503);
    }

    const { id } = await params;
    const result = await translateForProject(
      supabase,
      userId,
      { projectId: id, text: body.text, original: body.original, provenance: body.provenance },
      { mode, service },
    );
    if (!result.ok) return problem(result.code, result.message, result.status);
    return Response.json(
      { ok: true, english: result.english, sourceLanguage: result.sourceLanguage, numbersToCheck: result.numbersToCheck, model: result.model },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    slot.release();
  }
}
