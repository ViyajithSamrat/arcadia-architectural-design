import { describe, expect, it } from "vitest";
import { parseBrief, type BriefInput } from "@/lib/journeys/brief";
import { validateRequirements } from "@/lib/journeys/validation";
import { viewsFor } from "@/lib/generation/prompt";
import { getGnaniSttReadiness, getGnaniTtsReadiness, getOpenRouterConfig, getOpenRouterImageConfig, READBACK_LANGUAGE } from "@/lib/providers/config";
import { createGnaniSttProvider, createGnaniTtsProvider } from "@/lib/providers/gnani";
import { validateImageOutputs } from "@/lib/providers/images";
import { createOpenRouterBriefProvider } from "@/lib/providers/openrouter";
import { createOpenRouterImageProvider } from "@/lib/providers/openrouter-image";
import { looksLikeAudio } from "@/lib/voice/readback";
import { encodeWav } from "@/lib/voice/wav-encode";
import { storedRequirements } from "../unit/support/journey-fixtures";
import { readFileSync } from "node:fs";
import { assessKey, assessModel, SMOKE_PASS_BUDGET_USD, SpendGuard } from "./openrouter-guard";

/**
 * Bounded REAL-provider smoke tests: one STT, one TTS, one structured-text brief and one image.
 * Synthetic, non-sensitive data only. No retry loops. Nothing here proves more than it asserts: an
 * HTTP 200 is never enough, each test inspects the actual output. Secrets are never printed.
 *
 * These call the provider adapters directly, so the project's own budget ledger (a database) is NOT
 * in the loop. OpenRouter spending is guarded by openrouter-guard.ts BEFORE any paid request:
 *   1. the API key must carry its own credit limit of at most US$5 (OpenRouter enforces it) and
 *      have credit left;
 *   2. the model must be in OpenRouter's public list with the right output modality (image, or
 *      structured outputs for text) and a published price whose worst case for one request is at
 *      most US$1;
 *   3. a further paid request runs only if the real spend so far (read from the key's usage
 *      counter) plus that worst case still fits in US$5.
 * A failed preflight FAILS the test with the reasons and makes no paid request. Gnani has no
 * published price or credit unit, so its spend is bounded only by making one short request each.
 */

const ENABLED = process.env.LIVE_PROVIDER_SMOKE === "1";
const report = (name: string, details: Record<string, unknown>) => console.log(`SMOKE ${name} ${JSON.stringify(details)}`);

const stt = getGnaniSttReadiness();
const tts = getGnaniTtsReadiness();
const textConfig = getOpenRouterConfig();
const imageConfig = getOpenRouterImageConfig();

const OPENROUTER = "https://openrouter.ai/api/v1";
let guard: SpendGuard | null = null;

async function keyInfo(apiKey: string): Promise<unknown> {
  const res = await fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
  return res.ok ? res.json() : null;
}

/** Free read-only checks. Throws (so no paid request is made) unless every rule of the guard holds. */
async function preflight(kind: "text" | "image", apiKey: string, model: string): Promise<{ worstCaseUsd: number }> {
  const key = assessKey(await keyInfo(apiKey));
  if (!key.ok) throw new Error(`OpenRouter preflight refused: ${key.reasons.join("; ")}`);
  // The default list holds text models only; image models are listed with output_modalities.
  const list = await (await fetch(`${OPENROUTER}/models?output_modalities=all`, { signal: AbortSignal.timeout(30_000) })).json();
  const assessed = assessModel(list, model, kind);
  if (!assessed.ok) throw new Error(`OpenRouter preflight refused model ${model}: ${assessed.reasons.join("; ")}`);
  guard ??= new SpendGuard(key.usage!);
  const current = (await keyInfo(apiKey)) as { data?: { usage?: number } } | null;
  const usage = current?.data?.usage;
  if (typeof usage !== "number" || !guard.mayContinue(usage, assessed.worstCaseUsd!)) throw new Error("OpenRouter preflight refused: the next request could exceed the US$" + SMOKE_PASS_BUDGET_USD + " smoke-test budget");
  return { worstCaseUsd: assessed.worstCaseUsd! };
}

async function spentUsd(apiKey: string): Promise<number | null> {
  const current = (await keyInfo(apiKey)) as { data?: { usage?: number } } | null;
  return typeof current?.data?.usage === "number" && guard ? guard.spent(current.data.usage) : null;
}

describe.skipIf(!ENABLED)("REAL provider smoke tests", () => {
  it.skipIf(!stt.ready)("Gnani speech-to-text: one short synthetic WAV is accepted and answered in the documented shape", async () => {
    if (!stt.ready) return;
    const language = stt.config.languages[0];
    // 1.5 s of a quiet tone: synthetic, no speech, so the transcript may legitimately be empty.
    const samples = new Float32Array(24_000).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / 16_000));
    const audio = encodeWav(samples, 16_000);
    const started = Date.now();
    const out = await createGnaniSttProvider(stt.config).transcribe({ audio, mimeType: "audio/wav", language, requestId: crypto.randomUUID() });
    report("gnani-stt", { ms: Date.now() - started, language, transcriptChars: out.transcript.length, requestIdPresent: Boolean(out.requestId) });
    expect(typeof out.transcript).toBe("string");
  });

  // SMOKE_STT_WAV: a real speech recording (16 kHz mono WAV, under the length limit) of synthetic,
  // non-sensitive words. Its transcript is printed so numbers and terms can be checked by a person;
  // say in any report whether the speech was a human or a synthesised voice.
  const speechFile = process.env.SMOKE_STT_WAV;
  it.skipIf(!stt.ready || !speechFile)("Gnani speech-to-text: a real speech fixture is transcribed", async () => {
    if (!stt.ready || !speechFile) return;
    const language = process.env.SMOKE_STT_LANGUAGE ?? "en-IN";
    const audio = new Uint8Array(readFileSync(speechFile));
    const started = Date.now();
    const out = await createGnaniSttProvider(stt.config).transcribe({ audio, mimeType: "audio/wav", language, requestId: crypto.randomUUID() });
    report("gnani-stt-speech", { ms: Date.now() - started, language, bytes: audio.byteLength, transcript: out.transcript, requestIdPresent: Boolean(out.requestId) });
    expect(out.transcript.trim().length).toBeGreaterThan(0);
  });

  it.skipIf(!tts.ready)("Gnani text-to-speech: one short sentence returns real audio", async () => {
    if (!tts.ready) return;
    const started = Date.now();
    const out = await createGnaniTtsProvider(tts.config).synthesize({ text: "Hello. This is a short test of the read back voice.", language: READBACK_LANGUAGE, requestId: crypto.randomUUID() });
    report("gnani-tts", { ms: Date.now() - started, bytes: out.audio.byteLength, mimeType: out.mimeType });
    expect(looksLikeAudio(out.audio, out.mimeType)).toBe(true);
  });

  it.skipIf(!textConfig)("OpenRouter text: one structured brief passes the strict parser", async () => {
    if (!textConfig) return;
    const check = validateRequirements("EMPTY_PLOT", storedRequirements("EMPTY_PLOT"));
    if (!check.complete) throw new Error("fixture must be complete");
    const input: BriefInput = { projectType: "EMPTY_PLOT", sourceLanguage: "en", requirements: check.requirements };
    const { worstCaseUsd } = await preflight("text", textConfig.apiKey, textConfig.model);
    const started = Date.now();
    const out = await createOpenRouterBriefProvider(textConfig).generate(input);
    const parsed = parseBrief(out);
    report("openrouter-text", { ms: Date.now() - started, model: textConfig.model, parsed: parsed.ok, worstCaseUsd, spentSoFarUsd: await spentUsd(textConfig.apiKey) });
    expect(parsed.ok).toBe(true);
  });

  it.skipIf(!imageConfig)("OpenRouter image: one image is returned, validated and within the cost cap", async () => {
    if (!imageConfig) return;
    const { worstCaseUsd } = await preflight("image", imageConfig.apiKey, imageConfig.model);
    const views = viewsFor("INTERIOR").slice(0, 1);
    const provider = createOpenRouterImageProvider(imageConfig);
    const started = Date.now();
    const result = await provider.generate({ promptVersion: "smoke", instructions: "Create a calm, illustrative interior concept picture. It is a concept only.", views, customerData: { style: "minimalist", room: "living room" }, requestId: crypto.randomUUID(), timeoutMs: imageConfig.timeoutMsPerImage });
    const checked = validateImageOutputs(result.outputs, views);
    report("openrouter-image", { ms: Date.now() - started, model: imageConfig.model, valid: checked.ok, costUsd: result.costUsd ?? null, width: checked.ok ? checked.images[0].width : null, height: checked.ok ? checked.images[0].height : null, bytes: checked.ok ? checked.images[0].bytes.byteLength : null, requestIds: result.requestIds?.length ?? 0, worstCaseUsd, spentSoFarUsd: await spentUsd(imageConfig.apiKey) });
    expect(checked.ok).toBe(true);
    const spent = await spentUsd(imageConfig.apiKey);
    if (spent !== null) expect(spent).toBeLessThanOrEqual(SMOKE_PASS_BUDGET_USD);
  });
});
