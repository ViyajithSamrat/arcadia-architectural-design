import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_UNMETERED_LIMIT, planOpenRouterTranslation } from "@/lib/providers/budget";
import type { OpenRouterConfig } from "@/lib/providers/config";
import { ProviderError } from "@/lib/providers/interfaces";
import { MOCK_TRANSCRIPT } from "@/lib/providers/mock-speech";
import { createOpenRouterTranslator, numbersToCheck, TranslationRejectedError, type Translator } from "@/lib/providers/openrouter-translate";
import { getTranslationMode, getTranslationView, isEnglishLanguage } from "@/lib/translation/mode";
import { translateForProject, type TranslateDeps } from "@/lib/translation/service";
import { signTranscriptToken, verifyTranscriptToken, type TranscriptKey } from "@/lib/voice/provenance";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const KEY: TranscriptKey = { secret: Buffer.from("t".repeat(40)), mockOnly: false };
const TAMIL = "எனக்கு ஒரு ஹவுஸ் வேணும், 3 பெட்ரூம், 30 x 40 அடி";
const CONFIG: OpenRouterConfig = { apiKey: "or-SECRET-key", baseUrl: "https://openrouter.ai/api/v1", model: "test/model", referer: null, title: null, timeoutMs: 1000 };
const LIVE = { kind: "live", config: CONFIG } as const;

const token = (o: { transcript?: string; source?: "gnani" | "mock"; lang?: string | null; user?: string; project?: string } = {}) =>
  signTranscriptToken({ userId: o.user ?? ME, projectId: o.project ?? PROJECT, transcript: o.transcript ?? TAMIL, source: o.source ?? "gnani", sourceLanguage: o.lang === undefined ? "ta-IN" : o.lang }, KEY);

let userDb: FakeDb;
let serviceDb: FakeDb;
let translator: Translator & { translate: ReturnType<typeof vi.fn> };

function deps(patch: Partial<TranslateDeps> = {}): TranslateDeps {
  return { mode: LIVE, translator, service: serviceDb.client() as never, verifyTranscript: (t, e) => verifyTranscriptToken(t, e, [KEY]), ...patch };
}
const run = (input: Record<string, unknown> = {}, d: Partial<TranslateDeps> = {}, user = ME) =>
  translateForProject(userDb.client() as never, user, { projectId: PROJECT, text: TAMIL, original: TAMIL, provenance: token(), ...input }, deps(d));

beforeEach(() => {
  userDb = new FakeDb().seed("projects", [{ id: PROJECT, customer_id: ME, project_type: "EMPTY_PLOT", status: "DRAFT", requirements_json: {} }]);
  serviceDb = new FakeDb();
  serviceDb.rpcHandlers.ai_usage_reserve = () => ({ data: "usage-1" });
  serviceDb.rpcHandlers.ai_usage_finish = () => ({ data: null });
  translator = {
    id: "openrouter",
    model: "test/model",
    usage: planOpenRouterTranslation(CONFIG),
    translate: vi.fn(async () => ({ english: "I want a house, 3 bedrooms, 30 x 40 feet", model: "test/model", requestId: "r1" })),
  };
});

describe("translation mode", () => {
  it("is off by default, live only with the OpenRouter text settings, and fails closed otherwise", () => {
    expect(getTranslationMode({}).kind).toBe("off");
    expect(getTranslationMode({ TRANSLATION_MODE: "off" }).kind).toBe("off");
    expect(getTranslationMode({ TRANSLATION_MODE: "live" }).kind).toBe("unavailable");
    expect(getTranslationMode({ TRANSLATION_MODE: "live", OPENROUTER_API_KEY: "k" }).kind).toBe("unavailable");
    expect(getTranslationMode({ TRANSLATION_MODE: "live", OPENROUTER_API_KEY: "k", OPENROUTER_TEXT_MODEL: "m" }).kind).toBe("live");
    expect(getTranslationMode({ TRANSLATION_MODE: "mock", OPENROUTER_API_KEY: "k", OPENROUTER_TEXT_MODEL: "m" }).kind).toBe("unavailable");
    // the view never carries the configuration
    expect(getTranslationView({ TRANSLATION_MODE: "live", OPENROUTER_API_KEY: "k", OPENROUTER_TEXT_MODEL: "m" })).toBe("live");
  });

  it("knows English codes", () => {
    expect(isEnglishLanguage("en-IN")).toBe(true);
    expect(isEnglishLanguage("en")).toBe(true);
    expect(isEnglishLanguage("ta-IN")).toBe(false);
    expect(isEnglishLanguage(null)).toBe(false);
  });
});

describe("translateForProject", () => {
  it("translates the owner's reviewed transcript through the usage guard and flags figures to check", async () => {
    const result = await run();
    expect(result).toMatchObject({ ok: true, english: "I want a house, 3 bedrooms, 30 x 40 feet", sourceLanguage: "ta-IN", numbersToCheck: [] });
    expect(translator.translate).toHaveBeenCalledWith({ text: TAMIL, sourceLanguage: "ta-IN", maxChars: 2000 }, expect.anything());
    expect(serviceDb.rpcCalls.map((c) => c.name)).toEqual(["ai_usage_reserve", "ai_usage_finish"]);
    // Recorded under its own operation, with no ARCADIA quota (the limits are the non-binding ceiling).
    expect(serviceDb.rpcCalls[0].args).toMatchObject({ p_provider: "openrouter", p_operation: "translate", p_unit: "request", p_customer_id: ME, p_project_id: PROJECT, p_customer_limit: AI_UNMETERED_LIMIT, p_customer_window_minutes: 60, p_global_limit: AI_UNMETERED_LIMIT, p_global_window_minutes: 1440 });
    // nothing is written to the project: the customer decides whether to use the text
    expect(userDb.writes).toHaveLength(0);
  });

  it("is not stopped by an exhausted ARCADIA text budget: 500 requests already on the ledger no longer refuse a translation", async () => {
    const alreadyUsed = 500; // far above the old daily cap (40) and hourly allowance (6)
    serviceDb.rpcHandlers.ai_usage_reserve = (args) => {
      if (alreadyUsed + Number(args.p_units) > Number(args.p_customer_limit)) return { error: { code: "AI001", message: "x" } };
      if (alreadyUsed + Number(args.p_units) > Number(args.p_global_limit)) return { error: { code: "AI002", message: "x" } };
      return { data: "usage-1" };
    };
    expect(await run()).toMatchObject({ ok: true });
    expect(translator.translate).toHaveBeenCalledTimes(1);
    expect(serviceDb.rpcCalls.map((c) => c.name)).toEqual(["ai_usage_reserve", "ai_usage_finish"]);
  });

  it("translates an edited transcript, still bound to the original's provenance", async () => {
    const edited = "எனக்கு ஒரு வீடு வேண்டும், 3 பெட்ரூம்";
    expect(await run({ text: edited })).toMatchObject({ ok: true });
    expect(translator.translate).toHaveBeenCalledWith(expect.objectContaining({ text: edited }), expect.anything());
  });

  it.each([
    ["off", { mode: { kind: "off" } as const }, 404, "TRANSLATION_OFF"],
    ["unavailable", { mode: { kind: "unavailable" } as const }, 503, "TRANSLATION_UNAVAILABLE"],
  ])("refuses when translation is %s, before reading anything", async (_n, d, status, code) => {
    expect(await run({}, d)).toMatchObject({ ok: false, status, code });
    expect(translator.translate).not.toHaveBeenCalled();
  });

  it.each([
    ["no provenance", { provenance: undefined }],
    ["a forged provenance", { provenance: "v1.e30.AAAA" }],
    ["provenance for other text", { original: "something else" }],
    ["a mock transcript's provenance", { provenance: token({ source: "mock" }) }],
    ["a demo-language provenance", { provenance: token({ lang: null }) }],
    ["another project's provenance", { provenance: token({ project: "44444444-4444-4444-8444-444444444444" }) }],
    ["another user's provenance", { provenance: token({ user: OTHER }) }],
    ["an empty transcript", { text: "   " }],
    ["an over-long transcript", { text: "அ".repeat(2001) }],
    ["the mock placeholder", { text: MOCK_TRANSCRIPT }],
  ])("refuses %s without calling the provider or the ledger", async (_name, input) => {
    expect(await run(input)).toMatchObject({ ok: false });
    expect(translator.translate).not.toHaveBeenCalled();
    expect(serviceDb.rpcCalls).toHaveLength(0);
  });

  it("refuses an English transcript: nothing to translate", async () => {
    const english = "I want a house";
    expect(await run({ text: english, original: english, provenance: token({ transcript: english, lang: "en-IN" }) })).toMatchObject({ ok: false, code: "NOT_NEEDED" });
    expect(translator.translate).not.toHaveBeenCalled();
  });

  it("refuses another customer and a locked project", async () => {
    expect(await run({}, {}, OTHER)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    userDb = new FakeDb().seed("projects", [{ id: PROJECT, customer_id: ME, project_type: "EMPTY_PLOT", status: "AWAITING_PAYMENT", requirements_json: {} }]);
    expect(await run()).toMatchObject({ ok: false, code: "NOT_EDITABLE" });
    expect(translator.translate).not.toHaveBeenCalled();
  });

  it("does not call the provider when the usage reservation is refused", async () => {
    serviceDb.rpcHandlers.ai_usage_reserve = () => ({ error: { code: "AI001", message: "limit" } });
    expect(await run()).toMatchObject({ ok: false, status: 429, code: "LIMIT" });
    expect(translator.translate).not.toHaveBeenCalled();
  });

  it("reports provider failures without details and records the attempt as failed", async () => {
    translator.translate.mockRejectedValueOnce(new ProviderError("timeout", "secret detail or-SECRET-key"));
    const timeout = await run();
    expect(timeout).toMatchObject({ ok: false, status: 502, code: "PROVIDER_FAILED" });
    expect(JSON.stringify(timeout)).not.toMatch(/secret|or-SECRET/i);
    expect(serviceDb.rpcCalls.at(-1)).toMatchObject({ name: "ai_usage_finish", args: { p_status: "FAILED" } });

    translator.translate.mockRejectedValueOnce(new ProviderError("auth", "no credits"));
    expect(await run()).toMatchObject({ ok: false, status: 503, code: "TRANSLATION_UNAVAILABLE" });
    translator.translate.mockRejectedValueOnce(new TranslationRejectedError("invalid_shape"));
    expect(await run()).toMatchObject({ ok: false, code: "PROVIDER_FAILED" });
  });
});

describe("numbersToCheck", () => {
  it("lists figures that appear on only one side", () => {
    expect(numbersToCheck("3 bedrooms, 30 x 40", "3 bedrooms, 30 x 40 feet")).toEqual([]);
    expect(numbersToCheck("மூன்று பெட்ரூம், 30 x 40", "3 bedrooms, 30 x 50")).toEqual(["3", "50", "40"]);
    expect(numbersToCheck("1,200 sq ft", "1200 square feet")).toEqual([]);
  });
});

describe("the OpenRouter translation adapter", () => {
  const reply = (content: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify({ id: "gen-1", model: "test/model", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status }));

  it("is recorded as the ledger operation 'translate' and carries no ARCADIA quota", () => {
    expect(createOpenRouterTranslator(CONFIG).usage).toEqual({
      provider: "openrouter",
      operation: "translate",
      model: "test/model",
      unit: "request",
      units: 1,
      limits: { customerLimit: AI_UNMETERED_LIMIT, customerWindowMinutes: 60, globalLimit: AI_UNMETERED_LIMIT, globalWindowMinutes: 1440, maxInFlight: null },
    });
  });

  it("sends the transcript as data with a strict schema, one request, and returns the English", async () => {
    const fetch = reply({ english: "  I want a house  " });
    const out = await createOpenRouterTranslator(CONFIG, { fetch }).translate({ text: TAMIL, sourceLanguage: "ta-IN", maxChars: 2000 });
    expect(out).toEqual({ english: "I want a house", model: "test/model", requestId: "gen-1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[0].content).not.toContain(TAMIL);
    expect(body.messages[1].content).toContain(`<transcript>\n${TAMIL}\n</transcript>`);
    expect(body.messages[1].content).toContain("Tamil");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("asks for reasoning effort 'none' when configured, keeping the strict JSON schema", async () => {
    const fetch = reply({ english: "I want a house" });
    await createOpenRouterTranslator({ ...CONFIG, reasoningEffort: "none" }, { fetch }).translate({ text: TAMIL, sourceLanguage: "ta-IN", maxChars: 2000 });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    expect(body.provider).toEqual({ require_parameters: true });
  });

  it.each([
    ["free text", "Sure! Here it is: I want a house"],
    ["an extra field", { english: "x", status: "VERIFIED" }],
    ["an empty translation", { english: "   " }],
    ["an over-long translation", { english: "a".repeat(2001) }],
  ])("rejects %s", async (_n, content) => {
    await expect(createOpenRouterTranslator(CONFIG, { fetch: reply(content) }).translate({ text: TAMIL, sourceLanguage: "ta-IN", maxChars: 2000 })).rejects.toBeInstanceOf(TranslationRejectedError);
  });

  it("maps HTTP failures to provider errors", async () => {
    await expect(createOpenRouterTranslator(CONFIG, { fetch: reply({}, 402) }).translate({ text: TAMIL, sourceLanguage: "ta-IN", maxChars: 2000 })).rejects.toMatchObject({ code: "auth" });
    await expect(createOpenRouterTranslator(CONFIG, { fetch: reply({}, 503) }).translate({ text: TAMIL, sourceLanguage: "ta-IN", maxChars: 2000 })).rejects.toMatchObject({ code: "server" });
  });
});
