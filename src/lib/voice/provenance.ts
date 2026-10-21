import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isSet } from "@/lib/env/schema";
import { GNANI_STT_LANGUAGES } from "@/lib/providers/config";

/**
 * Transcript provenance: a short-lived token the transcribe route signs over what it actually
 * returned, so the description save can tell a transcript this server produced from text the
 * browser made up. It is an HMAC-SHA256 over the claims below, bound to:
 *   - the signed-in user and the project (checked against the save's own session and project),
 *   - the SHA-256 of the transcript exactly as returned,
 *   - the source ("mock" or "gnani") and the provider language code, set by the server only,
 *   - an expiry (TRANSCRIPT_TOKEN_TTL_MS).
 * Nothing is stored: no audio, no transcript, no token. A token can be presented again until it
 * expires, but only for the same user, project and transcript, where saving it again changes
 * nothing; it cannot be moved to another project, user or text.
 *
 * Keys:
 *   - VOICE_TRANSCRIPT_SECRET (server-only, at least 32 characters): signs every source.
 *   - Without it, mock mode signs with a random key held by this server process. Such a key can
 *     only vouch for MOCK transcripts, and its tokens stop verifying when the process restarts
 *     (the save then treats the text as typed). Live mode refuses to run without the secret.
 */

export const TRANSCRIPT_SECRET_ENV = "VOICE_TRANSCRIPT_SECRET";
export const TRANSCRIPT_SECRET_MIN_CHARS = 32;
export const TRANSCRIPT_TOKEN_TTL_MS = 30 * 60 * 1000;
/** Longest token accepted from a browser. */
export const TRANSCRIPT_TOKEN_MAX_CHARS = 2048;
/** Clock skew tolerated for a token issued "in the future". */
const ISSUED_SKEW_MS = 60 * 1000;
const VERSION = "v1";
const DOMAIN = "voice-transcript";

export type TranscriptSource = "mock" | "gnani";

export type TranscriptClaims = {
  userId: string;
  projectId: string;
  source: TranscriptSource;
  /** The provider language code the transcript was requested in; null for a demo-only selection. */
  sourceLanguage: string | null;
  issuedAt: number;
  expiresAt: number;
};

/** A signing or verification key. A process-local key may only vouch for mock transcripts. */
export type TranscriptKey = { secret: Buffer; mockOnly: boolean };

/** True when VOICE_TRANSCRIPT_SECRET is set and long enough. Never returns or logs the value. */
export function transcriptSecretConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return isSet(env, TRANSCRIPT_SECRET_ENV) && String(env[TRANSCRIPT_SECRET_ENV]).trim().length >= TRANSCRIPT_SECRET_MIN_CHARS;
}

function configuredKey(env: Record<string, string | undefined>): TranscriptKey | null {
  if (!transcriptSecretConfigured(env)) return null;
  return { secret: Buffer.from(String(env[TRANSCRIPT_SECRET_ENV]).trim(), "utf8"), mockOnly: false };
}

/**
 * One random key per server process, shared through globalThis because the route handler and
 * the server action may load this module separately.
 */
function processKey(): TranscriptKey {
  const holder = globalThis as typeof globalThis & { __voiceTranscriptProcessKey?: Buffer };
  holder.__voiceTranscriptProcessKey ??= randomBytes(32);
  return { secret: holder.__voiceTranscriptProcessKey, mockOnly: true };
}

/** The key to sign with, or null when this source may not be signed (live without the secret). */
export function transcriptSigningKey(source: TranscriptSource, env: Record<string, string | undefined> = process.env): TranscriptKey | null {
  return configuredKey(env) ?? (source === "mock" ? processKey() : null);
}

/** Every key a token may have been signed with. */
export function transcriptVerificationKeys(env: Record<string, string | undefined> = process.env): TranscriptKey[] {
  const configured = configuredKey(env);
  return configured ? [configured, processKey()] : [processKey()];
}

export const transcriptHash = (transcript: string): string => createHash("sha256").update(transcript, "utf8").digest("hex");

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const mac = (secret: Buffer, payload: string) => createHmac("sha256", secret).update(`${DOMAIN}.${VERSION}.${payload}`).digest();

const ClaimsSchema = z
  .object({
    sub: z.string().min(1).max(100),
    pid: z.string().min(1).max(100),
    th: z.string().regex(/^[0-9a-f]{64}$/),
    src: z.enum(["mock", "gnani"]),
    lang: z.enum(GNANI_STT_LANGUAGES).nullable(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export function signTranscriptToken(
  input: { userId: string; projectId: string; transcript: string; source: TranscriptSource; sourceLanguage: string | null },
  key: TranscriptKey,
  now: number = Date.now(),
): string {
  if (key.mockOnly && input.source !== "mock") throw new Error("a process-local key signs mock transcripts only");
  const claims = {
    sub: input.userId,
    pid: input.projectId,
    th: transcriptHash(input.transcript),
    src: input.source,
    lang: input.sourceLanguage,
    iat: now,
    exp: now + TRANSCRIPT_TOKEN_TTL_MS,
  };
  const payload = b64url(JSON.stringify(claims));
  return `${VERSION}.${payload}.${b64url(mac(key.secret, payload))}`;
}

/**
 * The claims of a genuine, unexpired token issued to this user for this project and exactly this
 * transcript; null for anything else (forged, altered, expired, another user, project or text).
 */
export function verifyTranscriptToken(
  token: unknown,
  expected: { userId: string; projectId: string; transcript: string },
  keys: readonly TranscriptKey[],
  now: number = Date.now(),
): TranscriptClaims | null {
  if (typeof token !== "string" || token.length === 0 || token.length > TRANSCRIPT_TOKEN_MAX_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload, signature] = parts;
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  const signer = keys.find((k) => {
    const wanted = mac(k.secret, payload);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  });
  if (!signer) return null;

  let parsed: z.infer<typeof ClaimsSchema>;
  try {
    const result = ClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  if (signer.mockOnly && parsed.src !== "mock") return null;
  if (parsed.exp <= now || parsed.iat > now + ISSUED_SKEW_MS || parsed.exp - parsed.iat > TRANSCRIPT_TOKEN_TTL_MS) return null;
  if (parsed.sub !== expected.userId || parsed.pid !== expected.projectId) return null;
  const wantedHash = Buffer.from(transcriptHash(expected.transcript), "hex");
  if (!timingSafeEqual(Buffer.from(parsed.th, "hex"), wantedHash)) return null;
  return { userId: parsed.sub, projectId: parsed.pid, source: parsed.src, sourceLanguage: parsed.lang, issuedAt: parsed.iat, expiresAt: parsed.exp };
}
