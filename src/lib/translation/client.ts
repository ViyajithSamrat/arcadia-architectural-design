/**
 * Browser helper that asks POST /api/projects/[id]/translate for an English suggestion of a
 * transcript. The server checks everything again; nothing here is trusted by it.
 */

export type TranslationOutcome = { ok: true; english: string; numbersToCheck: string[] } | { ok: false; message: string };

const FAILED = "The translation could not be requested. Check your connection and try again, or type the English version yourself.";

export async function requestTranslation(
  projectId: string,
  input: { text: string; original: string; provenance: string; signal?: AbortSignal },
  doFetch: typeof fetch = fetch,
): Promise<TranslationOutcome> {
  let response: Response;
  try {
    response = await doFetch(`/api/projects/${encodeURIComponent(projectId)}/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input.text, original: input.original, provenance: input.provenance }),
      credentials: "same-origin",
      signal: input.signal,
    });
  } catch {
    return { ok: false, message: FAILED };
  }
  let data: Record<string, unknown> | null;
  try {
    data = (await response.json()) as Record<string, unknown> | null;
  } catch {
    return { ok: false, message: FAILED };
  }
  if (response.ok && data && data.ok === true && typeof data.english === "string") {
    const numbers = Array.isArray(data.numbersToCheck) ? data.numbersToCheck.filter((n): n is string => typeof n === "string").slice(0, 20) : [];
    return { ok: true, english: data.english, numbersToCheck: numbers };
  }
  const error = data && typeof data.error === "object" && data.error ? (data.error as { message?: unknown }) : null;
  return { ok: false, message: typeof error?.message === "string" ? error.message : FAILED };
}
