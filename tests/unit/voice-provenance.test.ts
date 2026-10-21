import { describe, expect, it } from "vitest";
import {
  signTranscriptToken,
  TRANSCRIPT_TOKEN_TTL_MS,
  transcriptSecretConfigured,
  transcriptSigningKey,
  transcriptVerificationKeys,
  verifyTranscriptToken,
  type TranscriptKey,
} from "@/lib/voice/provenance";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const SECRET = "test-transcript-secret-0123456789-abcdef";
const KEY: TranscriptKey = { secret: Buffer.from(SECRET), mockOnly: false };
const NOW = 1_800_000_000_000;

const sign = (patch: Partial<Parameters<typeof signTranscriptToken>[0]> = {}, key = KEY, now = NOW) =>
  signTranscriptToken({ userId: ME, projectId: PROJECT, transcript: "Three bedrooms", source: "gnani", sourceLanguage: "ta-IN", ...patch }, key, now);
const expected = { userId: ME, projectId: PROJECT, transcript: "Three bedrooms" };

describe("transcript provenance tokens", () => {
  it("verify for the same user, project and exact transcript, returning only what the server signed", () => {
    expect(verifyTranscriptToken(sign(), expected, [KEY], NOW + 1000)).toMatchObject({ userId: ME, projectId: PROJECT, source: "gnani", sourceLanguage: "ta-IN" });
  });

  it.each([
    ["another user", { ...expected, userId: OTHER }],
    ["another project", { ...expected, projectId: OTHER_PROJECT }],
    ["edited text", { ...expected, transcript: "Three bedrooms." }],
  ])("are refused for %s", (_label, other) => {
    expect(verifyTranscriptToken(sign(), other, [KEY], NOW)).toBeNull();
  });

  it("are refused once expired, and when issued in the future", () => {
    const token = sign();
    expect(verifyTranscriptToken(token, expected, [KEY], NOW + TRANSCRIPT_TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(verifyTranscriptToken(token, expected, [KEY], NOW + TRANSCRIPT_TOKEN_TTL_MS)).toBeNull();
    expect(verifyTranscriptToken(sign({}, KEY, NOW + 10 * 60 * 1000), expected, [KEY], NOW)).toBeNull();
  });

  it("are refused when signed with another key, altered, truncated or malformed", () => {
    const token = sign();
    const other: TranscriptKey = { secret: Buffer.from("another-secret-that-is-long-enough-000"), mockOnly: false };
    expect(verifyTranscriptToken(token, expected, [other], NOW)).toBeNull();
    const [v, payload, sig] = token.split(".");
    // Change the claims (to a mock source) but keep the old signature.
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), src: "mock" })).toString("base64url");
    expect(verifyTranscriptToken(`${v}.${forged}.${sig}`, expected, [KEY], NOW)).toBeNull();
    expect(verifyTranscriptToken(`${v}.${payload}.${sig.slice(0, -2)}`, expected, [KEY], NOW)).toBeNull();
    for (const bad of [undefined, 5, "", "v1.x", "v2." + payload + "." + sig, "x".repeat(3000), `${v}.${payload}.${sig}.extra`]) {
      expect(verifyTranscriptToken(bad, expected, [KEY], NOW)).toBeNull();
    }
  });

  it("refuses a token the browser built itself, even one with a well-formed body", () => {
    const body = Buffer.from(JSON.stringify({ sub: ME, pid: PROJECT, th: "0".repeat(64), src: "gnani", lang: "ta-IN", iat: NOW, exp: NOW + 1000 })).toString("base64url");
    expect(verifyTranscriptToken(`v1.${body}.${Buffer.from("not a mac").toString("base64url")}`, expected, [KEY], NOW)).toBeNull();
  });
});

describe("transcript provenance keys", () => {
  it("need VOICE_TRANSCRIPT_SECRET of at least 32 characters to sign a live transcript", () => {
    expect(transcriptSecretConfigured({})).toBe(false);
    expect(transcriptSecretConfigured({ VOICE_TRANSCRIPT_SECRET: "short" })).toBe(false);
    expect(transcriptSecretConfigured({ VOICE_TRANSCRIPT_SECRET: SECRET })).toBe(true);
    expect(transcriptSigningKey("gnani", {})).toBeNull();
    expect(transcriptSigningKey("gnani", { VOICE_TRANSCRIPT_SECRET: SECRET })).toMatchObject({ mockOnly: false });
  });

  it("without the secret, the mock is signed with a process key that can never vouch for a live transcript", () => {
    const key = transcriptSigningKey("mock", {});
    expect(key).toMatchObject({ mockOnly: true });
    expect(transcriptSigningKey("mock", {})?.secret.equals(key!.secret)).toBe(true); // one key per process
    expect(() => sign({ source: "gnani" }, key!)).toThrow();
    const mockToken = sign({ source: "mock", sourceLanguage: null }, key!);
    expect(verifyTranscriptToken(mockToken, expected, transcriptVerificationKeys({}), NOW)).toMatchObject({ source: "mock" });
    // A "gnani" token signed with the process key (as if the key leaked into a forger's hands) is still refused.
    const forged = signTranscriptToken({ ...expected, source: "gnani", sourceLanguage: "ta-IN" }, { ...key!, mockOnly: false }, NOW);
    expect(verifyTranscriptToken(forged, expected, transcriptVerificationKeys({}), NOW)).toBeNull();
  });

  it("never put the secret or the transcript into the token", () => {
    const token = sign({}, { secret: Buffer.from(SECRET), mockOnly: false });
    const decoded = Buffer.from(token.split(".")[1], "base64url").toString();
    expect(token).not.toContain(SECRET);
    expect(decoded).not.toContain("Three bedrooms");
  });
});
