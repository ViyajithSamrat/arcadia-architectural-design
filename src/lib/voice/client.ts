/**
 * Browser helper that sends one recording to POST /api/projects/[id]/transcribe. It refuses
 * before any request is made unless the customer has agreed to the recording notice. The
 * server checks everything again; nothing here is trusted by it.
 */

export type TranscriptionOutcome =
  | {
      ok: true;
      transcript: string;
      mock: boolean;
      language: string;
      sourceLanguage: string | null;
      seconds: number;
      truncated: boolean;
      /** The server's provenance token for this transcript; opaque here, checked only by the server. */
      provenance: string | null;
    }
  | { ok: false; message: string };

/** Matches the server's limit on what it accepts back. */
const PROVENANCE_MAX_CHARS = 2048;

const FAILED = "The recording could not be sent. Check your connection and try again, or type your description.";

export async function requestTranscription(
  projectId: string,
  input: { audio: Blob; language: string; consent: boolean; signal?: AbortSignal },
  doFetch: typeof fetch = fetch,
): Promise<TranscriptionOutcome> {
  if (input.consent !== true) return { ok: false, message: "Please agree to the recording notice before sending audio." };
  const form = new FormData();
  form.append("language", input.language);
  form.append("consent", "true");
  form.append("audio", input.audio, "recording.wav");

  let response: Response;
  try {
    response = await doFetch(`/api/projects/${encodeURIComponent(projectId)}/transcribe`, { method: "POST", body: form, credentials: "same-origin", signal: input.signal });
  } catch {
    return { ok: false, message: FAILED };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: FAILED };
  }
  const data = body as Record<string, unknown> | null;
  if (response.ok && data && data.ok === true && typeof data.transcript === "string") {
    return {
      ok: true,
      transcript: data.transcript,
      mock: data.mock === true,
      language: typeof data.language === "string" ? data.language : input.language,
      sourceLanguage: typeof data.sourceLanguage === "string" ? data.sourceLanguage : null,
      seconds: typeof data.seconds === "number" ? data.seconds : 0,
      truncated: data.truncated === true,
      provenance: typeof data.provenance === "string" && data.provenance.length <= PROVENANCE_MAX_CHARS ? data.provenance : null,
    };
  }
  const error = data && typeof data.error === "object" && data.error ? (data.error as { message?: unknown }) : null;
  return { ok: false, message: typeof error?.message === "string" ? error.message : FAILED };
}
