import { AuthError } from "@/lib/auth/errors";
import { requireUser } from "@/lib/auth/guards";
import { getGnaniTtsReadiness } from "@/lib/providers/config";
import { isAllowedOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readbackLimiter } from "@/lib/voice/rate-limit";
import { READBACK_UNAVAILABLE_MESSAGE, synthesizeReadback } from "@/lib/voice/readback";

/**
 * POST /api/projects/[id]/readback: the project owner asks to hear the stored summary of their
 * own brief (JSON: { "consent": true }). The answer is audio, or a JSON error.
 *
 * The browser sends no text and no language: the server speaks only the summary it stored
 * with the owner's brief, in English (see src/lib/voice/readback.ts). Nothing is stored, and
 * nothing here is logged: no text, no audio, no header.
 *
 * Order: origin; whether speech is configured at all; a small declared body; sign-in; the per-user
 * rate limit (before any credit is reserved); then the service, which checks ownership, the brief,
 * consent and the spending limits before the one call to Gnani.
 */

const BODY_MAX_BYTES = 1024;

const json = (body: object, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const problem = (code: string, message: string, status: number, headers: Record<string, string> = {}) => json({ ok: false, error: { code, message } }, status, headers);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isAllowedOrigin(request)) return problem("BAD_ORIGIN", "Request not allowed.", 403);
  if (!getGnaniTtsReadiness().ready) return problem("READBACK_UNAVAILABLE", READBACK_UNAVAILABLE_MESSAGE, 503);

  const declared = Number(request.headers.get("content-length"));
  if (!request.headers.has("content-length") || !Number.isFinite(declared) || declared < 0) return problem("LENGTH_REQUIRED", "The request size was not declared.", 411);
  if (declared > BODY_MAX_BYTES) return problem("TOO_LARGE", "That request was too large.", 413);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return problem("UNSUPPORTED", "Send JSON.", 415);

  let supabase;
  let userId: string;
  try {
    supabase = await createSupabaseServerClient();
    userId = (await requireUser(supabase)).id;
  } catch (error) {
    if (error instanceof AuthError) return problem(error.code, error.message, error.status);
    throw error;
  }

  const slot = readbackLimiter().acquire(userId);
  if (!slot.ok) {
    const message = slot.reason === "rate" ? "Too many requests in a short time. Wait a moment and try again." : "A read-back is already being prepared. Wait for it to finish.";
    return problem(slot.reason === "rate" ? "RATE_LIMITED" : "BUSY", message, 429, { "Retry-After": String(slot.retryAfterSeconds) });
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return problem("BAD_REQUEST", "That request was not valid.", 400);
    }
    const { id } = await params;
    const consent = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).consent : undefined;

    const result = await synthesizeReadback(supabase, userId, { projectId: id, consent });
    if (!result.ok) return problem(result.code, result.message, result.status);
    return new Response(result.audio as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": result.mimeType,
        "Content-Length": String(result.audio.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Readback-Shortened": result.shortened ? "1" : "0",
      },
    });
  } finally {
    slot.release();
  }
}
