import type { SupabaseClient } from "@supabase/supabase-js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBriefProvider } from "@/lib/journeys/brief";
import { getIntegrationStatuses } from "@/lib/integrations/status";
import { getGnaniTtsReadiness, GNANI_HARD_CEILING_CREDITS, READBACK_LANGUAGE } from "@/lib/providers/config";
import { createGnaniTtsProvider } from "@/lib/providers/gnani";
import { FakeDb } from "./support/fake-supabase";
import { REQUIREMENTS } from "./support/journey-fixtures";

/**
 * Spoken read-back (Gnani text-to-speech) with the NETWORK FAKED. These prove the request
 * follows Gnani's documented shape, that only the server's stored summary is ever spoken, and
 * that every refusal and failure is safe. They do not prove a real Gnani account accepts it.
 */

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const KEY = "gnani-TTS-KEY-never-shown-0000";

const TTS_ENV = {
  GNANI_VOICE_ENABLED: "true", GNANI_API_KEY: KEY, GNANI_BASE_URL: "https://api.vachana.ai", GNANI_TTS_ENDPOINT: "/api/v1/tts/inference",
  GNANI_TTS_MODEL: "timbre-v2.5", GNANI_TTS_VOICE: "Nalini", GNANI_LANGUAGES: "en-IN,ta-IN", GNANI_CREDITS_PER_TTS_CHAR: "0.1",
  GNANI_MAX_CREDITS_PER_REQUEST: "100", GNANI_CUSTOMER_CREDITS_PER_HOUR: "300", GNANI_BUDGET_CREDITS: "1000",
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("getGnaniTtsReadiness: fail closed, names only", () => {
  it("is ready with every setting, and needs nothing for speech-to-text", () => {
    const r = getGnaniTtsReadiness(TTS_ENV);
    expect(r.ready).toBe(true);
    if (!r.ready) return;
    expect(r.config).toMatchObject({ baseUrl: "https://api.vachana.ai", ttsPath: "/api/v1/tts/inference", ttsModel: "timbre-v2.5", ttsVoice: "Nalini", creditsPerTtsChar: 0.1, maxTtsChars: 600, languages: ["en-IN", "ta-IN"] });
    expect(Object.keys(r.config)).not.toContain("sttPath");
  });

  it("lists exactly what is missing by NAME and never a value", () => {
    const none = getGnaniTtsReadiness({});
    expect(none).toMatchObject({ ready: false });
    expect(none.ready === false && none.missing).toEqual(expect.arrayContaining(["GNANI_VOICE_ENABLED=true", "GNANI_API_KEY", "GNANI_TTS_VOICE", "GNANI_BUDGET_CREDITS"]));
    const partial = getGnaniTtsReadiness({ ...TTS_ENV, GNANI_TTS_VOICE: "", GNANI_CREDITS_PER_TTS_CHAR: "" });
    expect(partial.ready).toBe(false);
    expect(partial.ready === false && [...partial.missing].sort()).toEqual(["GNANI_CREDITS_PER_TTS_CHAR", "GNANI_TTS_VOICE"]);
    expect(JSON.stringify(partial)).not.toContain(KEY);
  });

  it.each([
    ["voice not switched on", { GNANI_VOICE_ENABLED: "mock" }],
    ["voice switched on with another word", { GNANI_VOICE_ENABLED: "yes" }],
    ["no key", { GNANI_API_KEY: "" }],
    ["an unlisted model", { GNANI_TTS_MODEL: "timbre-v1" }],
    ["no model", { GNANI_TTS_MODEL: "" }],
    ["English not among the languages", { GNANI_LANGUAGES: "ta-IN" }],
    ["an unsafe endpoint path", { GNANI_TTS_ENDPOINT: "/../admin" }],
    ["a path without a slash", { GNANI_TTS_ENDPOINT: "tts" }],
    ["another host", { GNANI_BASE_URL: "https://evil.example" }],
    ["plain http", { GNANI_BASE_URL: "http://api.vachana.ai" }],
    ["a zero rate", { GNANI_CREDITS_PER_TTS_CHAR: "0" }],
    ["a negative budget", { GNANI_BUDGET_CREDITS: "-5" }],
    ["no per-request limit", { GNANI_MAX_CREDITS_PER_REQUEST: "" }],
    ["no per-customer limit", { GNANI_CUSTOMER_CREDITS_PER_HOUR: "" }],
  ])("is not ready with %s", (_name, patch) => {
    expect(getGnaniTtsReadiness({ ...TTS_ENV, ...patch }).ready).toBe(false);
  });

  it("clamps the budget to the owner's absolute ceiling and the text length to a sane range", () => {
    const r = getGnaniTtsReadiness({ ...TTS_ENV, GNANI_BUDGET_CREDITS: "999999", GNANI_TTS_MAX_CHARS: "99999" });
    expect(r.ready && r.config.budgetCredits).toBe(GNANI_HARD_CEILING_CREDITS);
    expect(r.ready && r.config.maxTtsChars).toBe(2000);
  });

  it("accepts the documented models", () => {
    for (const model of ["timbre-v2.5", "timbre-v3.0"]) expect(getGnaniTtsReadiness({ ...TTS_ENV, GNANI_TTS_MODEL: model }).ready).toBe(true);
  });
});

describe("the /status entry for spoken read-back", () => {
  const entry = (env: Record<string, string>) => getIntegrationStatuses(env).find((s) => s.id === "readback_audio")!;
  it("is not configured by default, partial naming settings, and configured but unverified when complete", () => {
    expect(entry({})).toMatchObject({ state: "not_configured" });
    expect(entry({ GNANI_VOICE_ENABLED: "mock" })).toMatchObject({ state: "not_configured" });
    expect(entry({ GNANI_VOICE_ENABLED: "true", GNANI_API_KEY: KEY })).toMatchObject({ state: "partial" });
    const done = entry(TTS_ENV);
    expect(done).toMatchObject({ state: "configured_unverified", missing: [] });
    expect(done.message).toMatch(/does not confirm the service works/);
    expect(JSON.stringify(done)).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------
// The adapter's request
// ---------------------------------------------------------------------------

const RIFF = (n = 4000) => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
};
const audioResponse = (bytes: Uint8Array = RIFF(), type = "audio/wav") => new Response(bytes as BodyInit, { status: 200, headers: { "content-type": type } });

type Call = { url: string; init: RequestInit };
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const ttsConfig = () => {
  const r = getGnaniTtsReadiness(TTS_ENV);
  if (!r.ready) throw new Error("expected ready");
  return r.config;
};

describe("the Gnani TTS request", () => {
  it("is one JSON POST with the documented fields, header and audio configuration", async () => {
    const f = fakeFetch(audioResponse());
    const out = await createGnaniTtsProvider(ttsConfig(), { fetch: f.fn }).synthesize({ text: "Hello there.", language: "en-IN", requestId: "11111111-1111-4111-8111-111111111111" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://api.vachana.ai/api/v1/tts/inference");
    expect(f.calls[0].init.method).toBe("POST");
    expect(f.calls[0].init.headers).toMatchObject({ "X-API-Key-ID": KEY, "Content-Type": "application/json", "X-API-Request-ID": "11111111-1111-4111-8111-111111111111" });
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      text: "Hello there.", model: "timbre-v2.5", voice: "Nalini", language: "en-IN", speed: 1.0,
      audio_config: { sample_rate: 24000, num_channels: 1, sample_width: 2, encoding: "linear_pcm", container: "wav" },
    });
    expect(out).toMatchObject({ mimeType: "audio/wav", provider: "gnani", model: "timbre-v2.5" });
    expect(out.audio.byteLength).toBe(4000);
  });

  it("refuses an unsupported language or oversized text before any request, saying nothing was sent", async () => {
    const f = fakeFetch(audioResponse());
    const onNotSent = vi.fn();
    const p = createGnaniTtsProvider(ttsConfig(), { fetch: f.fn });
    await expect(p.synthesize({ text: "x", language: "fr-FR", requestId: "r" }, { onNotSent })).rejects.toMatchObject({ code: "unsupported_input" });
    await expect(p.synthesize({ text: "x".repeat(601), language: "en-IN", requestId: "r" }, { onNotSent })).rejects.toMatchObject({ code: "unsupported_input" });
    await expect(p.synthesize({ text: "   ", language: "en-IN", requestId: "r" }, { onNotSent })).rejects.toMatchObject({ code: "unsupported_input" });
    expect(f.calls).toHaveLength(0);
    expect(onNotSent).toHaveBeenCalledTimes(3);
  });

  it.each([
    [401, "auth"], [403, "auth"], [429, "rate_limited"], [400, "bad_request"], [500, "server"], [503, "server"],
  ])("maps HTTP %i to %s with one call and no retry", async (status, code) => {
    const f = fakeFetch(new Response("{}", { status }));
    await expect(createGnaniTtsProvider(ttsConfig(), { fetch: f.fn }).synthesize({ text: "x", language: "en-IN", requestId: "r" })).rejects.toMatchObject({ code });
    expect(f.calls).toHaveLength(1);
  });

  it("rejects a response that is not audio, empty audio, or audio over the limit", async () => {
    const p = (r: Response) => createGnaniTtsProvider(ttsConfig(), { fetch: fakeFetch(r).fn }).synthesize({ text: "x", language: "en-IN", requestId: "r" });
    await expect(p(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }))).rejects.toMatchObject({ code: "bad_response" });
    await expect(p(audioResponse(new Uint8Array(0)))).rejects.toMatchObject({ code: "bad_response" });
    await expect(p(new Response(RIFF() as BodyInit, { status: 200, headers: { "content-type": "audio/wav", "content-length": String(50 * 1024 * 1024) } }))).rejects.toMatchObject({ code: "bad_response" });
  });

  it("does not retry a timeout", async () => {
    const f = fakeFetch(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect(createGnaniTtsProvider(ttsConfig(), { fetch: f.fn }).synthesize({ text: "x", language: "en-IN", requestId: "r" })).rejects.toMatchObject({ code: "timeout" });
    expect(f.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The service and the route
// ---------------------------------------------------------------------------

let db: FakeDb;
let ledger: FakeDb;
let signedInAs: string | null;
let calls: Call[];
let respond: () => Response | Error;
const serverClient = vi.fn(async (): Promise<SupabaseClient> => {
  const client = db.client() as unknown as Record<string, unknown>;
  client.auth = { getUser: async () => (signedInAs ? { data: { user: { id: signedInAs } }, error: null } : { data: { user: null }, error: { message: "no session" } }) };
  return client as unknown as SupabaseClient;
});
const serviceClient = vi.fn(() => ledger.client());
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => serverClient() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: () => serviceClient() }));

const { POST } = await import("@/app/api/projects/[id]/readback/route");
const { readbackLimiter, READBACK_LIMITS } = await import("@/lib/voice/rate-limit");
const { fitForSpeech, looksLikeAudio, synthesizeReadback } = await import("@/lib/voice/readback");

const ENV_KEYS = [...Object.keys(TTS_ENV), "PROVIDER_MODE", "GNANI_TTS_MAX_CHARS"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (values: Record<string, string>) => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
};

const SUMMARY = "A new two floor home on a 30 by 40 foot plot in Chennai. It needs three bedrooms and two bathrooms. The preferred style is modern.";
const logs = () => [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls].flat().map(String).join("\n");
const reservations = () => ledger.rpcCalls.filter((c) => c.name === "ai_usage_reserve");
const finishes = () => ledger.rpcCalls.filter((c) => c.name === "ai_usage_finish");

async function seedProject(patch: Record<string, unknown> = {}, readback: string | null = SUMMARY) {
  const brief = (await mockBriefProvider.generate({ projectType: "EMPTY_PLOT", sourceLanguage: "en", requirements: REQUIREMENTS.EMPTY_PLOT })) as Record<string, unknown>;
  const withText = readback === null ? brief : { ...brief, customerReadbackText: readback };
  db = new FakeDb().seed("projects", [{ id: PROJECT, customer_id: ME, project_type: "EMPTY_PLOT", status: "BRIEF_REVIEW", english_brief_json: withText, requirements_json: { schemaVersion: 1 }, ...patch }]);
}

beforeEach(async () => {
  await seedProject();
  ledger = new FakeDb();
  ledger.rpcHandlers.ai_usage_reserve = () => ({ data: "usage-1" });
  ledger.rpcHandlers.ai_usage_finish = () => ({ data: null });
  signedInAs = ME;
  calls = [];
  respond = () => audioResponse();
  serverClient.mockClear();
  serviceClient.mockClear();
  setEnv(TTS_ENV);
  readbackLimiter().reset();
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const out = respond();
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const URL_ = `http://localhost:3000/api/projects/${PROJECT}/readback`;
const ctx = (id = PROJECT) => ({ params: Promise.resolve({ id }) });
const request = (body: unknown = { consent: true }, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(URL_, { method: "POST", headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(text).byteLength), ...headers }, body: text });
};

describe("fitForSpeech and looksLikeAudio", () => {
  it("keeps a short summary whole and tidies its spacing", () => {
    expect(fitForSpeech("  A   short\n summary.  ", 600)).toEqual({ text: "A short summary.", shortened: false });
  });
  it("cuts a long summary at a sentence end when it can, else at a word, and says it was shortened", () => {
    const cut = fitForSpeech(SUMMARY, 90);
    expect(cut.shortened).toBe(true);
    expect(cut.text).toBe("A new two floor home on a 30 by 40 foot plot in Chennai.");
    const noStops = fitForSpeech("word ".repeat(100).trim(), 50);
    expect(noStops.shortened).toBe(true);
    expect(noStops.text.length).toBeLessThanOrEqual(50);
    expect(noStops.text.endsWith(" ")).toBe(false);
    expect(fitForSpeech("x".repeat(100), 50).text).toHaveLength(50);
  });
  it("accepts real WAV, OGG and MP3 headers and rejects everything else, whatever type is declared", () => {
    expect(looksLikeAudio(RIFF(), "audio/wav")).toBe(true);
    expect(looksLikeAudio(RIFF(), "audio/x-wav")).toBe(true);
    const ogg = new Uint8Array(100);
    ogg.set(new TextEncoder().encode("OggS"));
    expect(looksLikeAudio(ogg, "audio/ogg")).toBe(true);
    const mp3 = new Uint8Array(100);
    mp3.set(new TextEncoder().encode("ID3"));
    expect(looksLikeAudio(mp3, "audio/mpeg")).toBe(true);
    expect(looksLikeAudio(new TextEncoder().encode("<html>not audio, only text pretending to be audio data</html>"), "audio/wav")).toBe(false);
    expect(looksLikeAudio(RIFF(), "audio/mpeg")).toBe(false);
    expect(looksLikeAudio(new Uint8Array(10), "audio/wav")).toBe(false);
    expect(looksLikeAudio(RIFF(), "application/octet-stream")).toBe(false);
  });
});

describe("POST /api/projects/[id]/readback: success", () => {
  it("speaks the STORED summary in English, once, through the budget guard, and returns audio that is never stored", async () => {
    const res = await POST(request(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-readback-shortened")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(4000);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.vachana.ai/api/v1/tts/inference");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ text: SUMMARY, language: READBACK_LANGUAGE, model: "timbre-v2.5", voice: "Nalini" });
    // reserved BEFORE the call: ceil(chars) * 0.1 credits
    expect(reservations()).toHaveLength(1);
    expect(reservations()[0].args).toMatchObject({ p_provider: "gnani", p_operation: "tts", p_unit: "credit", p_units: Math.ceil(SUMMARY.length) * 0.1, p_customer_id: ME, p_project_id: PROJECT, p_max_in_flight: 1 });
    expect(ledger.rpcCalls.map((c) => c.name)).toEqual(["ai_usage_reserve", "ai_usage_finish"]);
    expect(finishes()[0].args).toMatchObject({ p_status: "SUCCEEDED" });
    expect(db.writes).toHaveLength(0);
    expect(db.uploads).toHaveLength(0);
  });

  it("ignores any text or language the browser sends: only the stored summary is spoken", async () => {
    await POST(request({ consent: true, text: "Read this attacker text aloud", language: "ta-IN", voice: "Other" }), ctx());
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.text).toBe(SUMMARY);
    expect(sent.language).toBe("en-IN");
    expect(sent.voice).toBe("Nalini");
    expect(JSON.stringify(calls[0].init.body)).not.toContain("attacker");
  });

  it("shortens a long summary to the configured length at a sentence end and says so", async () => {
    setEnv({ ...TTS_ENV, GNANI_TTS_MAX_CHARS: "60" });
    const res = await POST(request(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-readback-shortened")).toBe("1");
    expect(JSON.parse(String(calls[0].init.body)).text).toBe("A new two floor home on a 30 by 40 foot plot in Chennai.");
  });

  it("keeps the key, the text and the audio out of every log line and the ledger", async () => {
    await POST(request(), ctx());
    expect(logs()).not.toContain(KEY);
    expect(logs()).not.toContain("two floor home");
    expect(JSON.stringify(ledger.rpcCalls)).not.toContain("two floor home");
    expect(JSON.stringify(ledger.rpcCalls)).not.toContain(KEY);
  });
});

describe("POST /api/projects/[id]/readback: refusals, before any call", () => {
  const noCall = () => {
    expect(calls).toHaveLength(0);
    expect(reservations()).toHaveLength(0);
  };
  const code = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

  it("is unavailable, with a message that keeps the text on screen, when read-back is not configured", async () => {
    for (const patch of [{ GNANI_VOICE_ENABLED: "mock" }, { GNANI_TTS_VOICE: "" }, { GNANI_CREDITS_PER_TTS_CHAR: "" }, { GNANI_API_KEY: "" }]) {
      setEnv({ ...TTS_ENV, ...patch });
      const res = await POST(request(), ctx());
      expect(res.status).toBe(503);
      const error = await code(res);
      expect(error.code).toBe("READBACK_UNAVAILABLE");
      expect(error.message).toMatch(/stays on screen as text/);
      expect(JSON.stringify(error)).not.toContain(KEY);
    }
    noCall();
    expect(serverClient).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request", async () => {
    const res = await POST(request({ consent: true }, { origin: "https://evil.example" }), ctx());
    expect(res.status).toBe(403);
    noCall();
  });

  it("requires a declared small JSON body", async () => {
    expect((await POST(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), ctx())).status).toBe(411);
    expect((await POST(request({ consent: true, pad: "x".repeat(2000) }), ctx())).status).toBe(413);
    expect((await POST(request("consent=true", { "content-type": "text/plain" }), ctx())).status).toBe(415);
    noCall();
  });

  it("refuses a caller who is not signed in", async () => {
    signedInAs = null;
    expect((await POST(request(), ctx())).status).toBe(401);
    noCall();
  });

  it("refuses without consent, including a string or a missing value", async () => {
    for (const body of [{ consent: false }, { consent: "true" }, { consent: 1 }, {}, [], null]) {
      readbackLimiter().reset();
      const res = await POST(request(body), ctx());
      expect(res.status).toBe(400);
      expect((await code(res)).code).toBe("CONSENT_REQUIRED");
    }
    noCall();
  });

  it("refuses malformed JSON", async () => {
    expect((await POST(request("{not json"), ctx())).status).toBe(400);
    noCall();
  });

  it("tells another customer, and an unknown id, only that the project was not found", async () => {
    signedInAs = OTHER;
    expect((await POST(request(), ctx())).status).toBe(404);
    signedInAs = ME;
    readbackLimiter().reset();
    expect((await POST(request(), ctx("44444444-4444-4444-8444-444444444444"))).status).toBe(404);
    noCall();
  });

  it("refuses a project with no brief yet", async () => {
    await seedProject({ english_brief_json: null });
    const res = await POST(request(), ctx());
    expect(res.status).toBe(409);
    expect((await code(res)).code).toBe("NO_BRIEF");
    noCall();
  });

  it("falls back to the brief text when the summary is empty, and speaks that stored text only", async () => {
    await seedProject({}, "   ");
    const brief = (db.tables.projects[0] as { english_brief_json: Record<string, unknown> }).english_brief_json;
    db.tables.projects[0].english_brief_json = { ...brief, customerReadbackText: "", englishBrief: "The stored brief text." };
    const res = await POST(request(), ctx());
    expect(res.status).toBe(200);
    expect(JSON.parse(String(calls[0].init.body)).text).toBe("The stored brief text.");
  });

  it("refuses a stored brief that has no text at all, because it is not a valid brief", async () => {
    await seedProject({}, "");
    const brief = (db.tables.projects[0] as { english_brief_json: Record<string, unknown> }).english_brief_json;
    db.tables.projects[0].english_brief_json = { ...brief, customerReadbackText: "", englishBrief: " " };
    const res = await POST(request(), ctx());
    expect(res.status).toBe(409);
    expect((await code(res)).code).toBe("NO_BRIEF");
    noCall();
  });

  it("has no ARCADIA per-request credit maximum: the old setting no longer refuses a read-back", async () => {
    setEnv({ ...TTS_ENV, GNANI_MAX_CREDITS_PER_REQUEST: "1" });
    const res = await POST(request(), ctx());
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(reservations()).toHaveLength(1);
  });

  it("makes no call when the budget guard refuses or is unreachable", async () => {
    for (const [handler, status] of [[() => ({ error: { code: "AI001", message: "x" } }), 429], [() => ({ error: { code: "AI002", message: "x" } }), 429], [() => ({ error: { code: "AI003", message: "x" } }), 429], [() => ({ error: { message: "db down" } }), 503]] as const) {
      ledger.rpcHandlers.ai_usage_reserve = handler;
      readbackLimiter().reset();
      const res = await POST(request(), ctx());
      expect(res.status).toBe(status);
      expect(JSON.stringify(await res.json())).not.toMatch(/credit|budget|gnani/i);
    }
    expect(calls).toHaveLength(0);
  });

  it("is unavailable, with no call, when the trusted ledger client cannot be created", async () => {
    serviceClient.mockImplementationOnce(() => {
      throw new Error("no service key");
    });
    const res = await POST(request(), ctx());
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("limits each user to a few requests a minute and one at a time, before any credit is reserved", async () => {
    for (let i = 0; i < READBACK_LIMITS.maxPerWindow; i += 1) expect((await POST(request(), ctx())).status).toBe(200);
    const limited = await POST(request(), ctx());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(calls).toHaveLength(READBACK_LIMITS.maxPerWindow);
    // another user is not affected
    signedInAs = OTHER;
    db.tables.projects[0].customer_id = OTHER;
    expect((await POST(request(), ctx())).status).toBe(200);
  });
});

describe("POST /api/projects/[id]/readback: a failure is a failure", () => {
  const failures: [string, () => Response | Error][] = [
    ["a Gnani server error", () => new Response("{}", { status: 500 })],
    ["a refused key or no credits", () => new Response("{}", { status: 403 })],
    ["a provider rate limit", () => new Response("{}", { status: 429 })],
    ["a timeout", () => Object.assign(new Error("t"), { name: "TimeoutError" })],
    ["a dropped connection", () => new TypeError("fetch failed")],
    ["a response that is not audio", () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["bytes that are not audio under an audio type", () => audioResponse(new TextEncoder().encode("this is plain text, not a wav file, not even close to one"), "audio/wav")],
    ["an empty audio body", () => audioResponse(new Uint8Array(0))],
  ];
  it.each(failures)("answers %s with a safe 502, one call, no retry, no audio and no secret", async (_name, make) => {
    respond = make;
    const res = await POST(request(), ctx());
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toMatch(/json/);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("PROVIDER_FAILED");
    expect(text).toContain("stays on screen as text");
    expect(text).not.toContain(KEY);
    expect(calls).toHaveLength(1);
    expect(reservations()).toHaveLength(1); // the call was made, so it counts against the budget
    expect(logs()).not.toContain(KEY);
  });

  it("the service reports the same without a route (no mock audio is ever produced)", async () => {
    respond = () => new Response("{}", { status: 500 });
    const result = await synthesizeReadback(await serverClient(), ME, { projectId: PROJECT, consent: true });
    expect(result).toMatchObject({ ok: false, status: 502, code: "PROVIDER_FAILED" });
  });
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

describe("ReadbackSummary with spoken read-back", () => {
  it("offers a consent-gated Listen control, and no audio element, before anything has happened", async () => {
    const { ReadbackSummary } = await import("@/components/journey/readback-summary");
    const out = renderToStaticMarkup(createElement(ReadbackSummary, { text: SUMMARY, audioProjectId: PROJECT })).replace(/&#x27;/g, "'");
    expect(out).toContain(SUMMARY);
    expect(out).toContain("Listen to this summary");
    expect(out).toContain("Gnani, a third-party speech service");
    expect(out).toContain("does not store the audio");
    expect(out).toContain("How long Gnani keeps the text has not been confirmed");
    expect(out).toMatch(/<button[^>]*disabled/);
    expect(out).not.toContain("<audio");
    expect(out).not.toContain("not switched on in this setup");
  });

  it("falls back to the text notice when read-back is not configured, or when there is nothing to say", async () => {
    const { ReadbackSummary } = await import("@/components/journey/readback-summary");
    expect(renderToStaticMarkup(createElement(ReadbackSummary, { text: SUMMARY, audioProjectId: null }))).toContain("not switched on in this setup");
    expect(renderToStaticMarkup(createElement(ReadbackSummary, { text: "  ", audioProjectId: PROJECT }))).not.toContain("Listen to this summary");
  });
});
