import { AuthError } from "@/lib/auth/errors";
import { requireUser } from "@/lib/auth/guards";
import { getVoiceMode, LIVE_STT_WIRED } from "@/lib/journeys/voice";
import { wavMaxBytes } from "@/lib/providers/wav";
import { isAllowedOrigin } from "@/lib/supabase/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createLiveSpeechDeps } from "@/lib/voice/live";
import { transcribeLimiter } from "@/lib/voice/rate-limit";
import { transcribeForProject, type LiveSpeechDeps, VOICE_OFF_MESSAGE, VOICE_UNAVAILABLE_MESSAGE } from "@/lib/voice/service";

/**
 * POST /api/projects/[id]/transcribe: the project owner sends one short WAV recording
 * (multipart: `audio`, `language`, `consent=true`) and gets back text to review. Nothing is
 * stored: the audio stays in this request's memory and the transcript is only returned.
 *
 * A Route Handler, like /api/payments, so the size limit applies to this route alone and is
 * checked before the body is read. Nothing here is logged: no audio, transcript or header.
 * The labelled mock answers in mock mode. In live mode the request is refused with 503 unless every
 * live setting is present; it is never answered by the mock (see src/lib/journeys/voice.ts).
 *
 * After sign-in, each user may send a limited number of recordings, one at a time
 * (rate-limit.ts), before the body is read. The success response carries a provenance token the
 * description save needs to store the text as a transcript (provenance.ts).
 */

/** Multipart boundaries and the two small text fields. */
const FORM_OVERHEAD_BYTES = 16 * 1024;

const json = (body: object, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const problem = (code: string, message: string, status: number, headers: Record<string, string> = {}) =>
  Response.json({ ok: false, error: { code, message } }, { status, headers: { "Cache-Control": "no-store", ...headers } });

const RATE_LIMITED = "Too many recordings in a short time. Wait a moment and try again, or type your description.";
const ONE_AT_A_TIME = "A recording is already being processed. Wait for it to finish.";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isAllowedOrigin(request)) return problem("BAD_ORIGIN", "Request not allowed.", 403);

  const mode = getVoiceMode();
  if (mode.kind === "off") return problem("VOICE_OFF", VOICE_OFF_MESSAGE, 404);
  if (mode.kind !== "mock" && !(mode.kind === "live" && LIVE_STT_WIRED)) return problem("VOICE_UNAVAILABLE", VOICE_UNAVAILABLE_MESSAGE, 503);

  // Refuse before reading anything: the declared size must be present and within the limit.
  const declared = Number(request.headers.get("content-length"));
  if (!request.headers.has("content-length") || !Number.isFinite(declared) || declared < 0) {
    return problem("LENGTH_REQUIRED", "The request size was not declared.", 411);
  }
  if (declared > wavMaxBytes(mode.maxSeconds) + FORM_OVERHEAD_BYTES) {
    return problem("TOO_LARGE", `The recording is too long. Keep it under ${mode.maxSeconds} seconds.`, 413);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return problem("UNSUPPORTED", "Send the recording as a form.", 415);
  }

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
  const slot = transcribeLimiter().acquire(userId);
  if (!slot.ok) {
    return slot.reason === "rate"
      ? problem("RATE_LIMITED", RATE_LIMITED, 429, { "Retry-After": String(slot.retryAfterSeconds) })
      : problem("BUSY", ONE_AT_A_TIME, 429, { "Retry-After": String(slot.retryAfterSeconds) });
  }
  try {
    let live: LiveSpeechDeps | undefined;
    if (mode.kind === "live" && LIVE_STT_WIRED) {
      // Built before the body is read; a setup failure is "unavailable", never an unhandled error.
      const deps = createLiveSpeechDeps(mode.config);
      if (!deps) return problem("VOICE_UNAVAILABLE", VOICE_UNAVAILABLE_MESSAGE, 503);
      live = deps;
    }

    const { id } = await params;
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return problem("BAD_REQUEST", "That request was not valid.", 400);
    }

    const result = await transcribeForProject(
      supabase,
      userId,
      { projectId: id, language: form.get("language"), consent: form.get("consent") === "true", audio: form.get("audio") },
      { mode, live },
    );

    if (!result.ok) return problem(result.code, result.message, result.status);
    return json(
      {
        ok: true,
        transcript: result.transcript,
        mock: result.mock,
        language: result.language,
        sourceLanguage: result.sourceLanguage,
        seconds: result.seconds,
        truncated: result.truncated,
        provenance: result.provenance,
      },
      200,
    );
  } finally {
    slot.release();
  }
}
