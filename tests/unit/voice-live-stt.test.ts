import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_UNMETERED_LIMIT } from "@/lib/providers/budget";
import { MOCK_TRANSCRIPT_PREFIX } from "@/lib/providers/mock-speech";
import { encodeWav } from "@/lib/voice/wav-encode";
import { FakeDb } from "./support/fake-supabase";

/**
 * The LIVE speech-to-text path (Gnani), with the NETWORK FAKED: the real route, service, budget
 * ledger calls and provenance token run; only fetch is replaced. These prove the code follows
 * Gnani's documented request and response, spends only through the guard and fails closed.
 * They do not prove that a real Gnani account accepts the call (that needs a key and a bounded
 * smoke test).
 */

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const KEY = "gnani-LIVE-KEY-never-shown-0000";
const TRANSCRIPT_SECRET = "live-route-transcript-SECRET-0123456789";
const SPOKEN = "நாங்கள் 30 அடி 40 அடி மனை";

let db: FakeDb;
let ledger: FakeDb;
let signedInAs: string | null;
const serverClient = vi.fn(async (): Promise<SupabaseClient> => {
  const client = db.client() as unknown as Record<string, unknown>;
  client.auth = { getUser: async () => (signedInAs ? { data: { user: { id: signedInAs } }, error: null } : { data: { user: null }, error: { message: "no session" } }) };
  return client as unknown as SupabaseClient;
});
const serviceClient = vi.fn(() => ledger.client());
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => serverClient() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: () => serviceClient() }));

const { POST } = await import("@/app/api/projects/[id]/transcribe/route");
const { transcribeLimiter } = await import("@/lib/voice/rate-limit");
const { transcriptVerificationKeys, verifyTranscriptToken } = await import("@/lib/voice/provenance");

const LIVE_ENV = {
  GNANI_VOICE_ENABLED: "true", GNANI_API_KEY: KEY, GNANI_BASE_URL: "https://api.vachana.ai", GNANI_STT_ENDPOINT: "/stt/v3", GNANI_LANGUAGES: "ta-IN,en-IN",
  GNANI_CREDITS_PER_STT_SECOND: "2", GNANI_MAX_CREDITS_PER_REQUEST: "100", GNANI_CUSTOMER_CREDITS_PER_HOUR: "300", GNANI_BUDGET_CREDITS: "1000",
  VOICE_TRANSCRIPT_SECRET: TRANSCRIPT_SECRET,
};
const ENV_KEYS = [...Object.keys(LIVE_ENV), "PROVIDER_MODE", "GNANI_STT_MAX_SECONDS", "PROVIDER_TIMEOUT_MS"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (values: Record<string, string>) => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
};

const URL_ = `http://localhost:3000/api/projects/${PROJECT}/transcribe`;
const ctx = (id = PROJECT) => ({ params: Promise.resolve({ id }) });
const wav = (seconds: number) => new Blob([encodeWav(new Float32Array(Math.round(seconds * 16_000)), 16_000) as BlobPart], { type: "audio/wav" });
async function multipart(fields: Record<string, string | Blob>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const draft = new Request(URL_, { method: "POST", body: form });
  const body = await draft.arrayBuffer();
  return new Request(URL_, { method: "POST", headers: { "content-type": draft.headers.get("content-type")!, "content-length": String(body.byteLength) }, body });
}
const good = () => ({ language: "ta-IN", consent: "true", audio: wav(1) });

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: () => Response | Error;
const gnaniOk = (extra: Record<string, unknown> = {}) => Response.json({ success: true, request_id: "req_abc123", timestamp: "20261021_120000.000", transcript: SPOKEN, ...extra });

const logs = () => [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls].flat().map(String).join("\n");
const reservations = () => ledger.rpcCalls.filter((c) => c.name === "ai_usage_reserve");
const finishes = () => ledger.rpcCalls.filter((c) => c.name === "ai_usage_finish");

beforeEach(() => {
  db = new FakeDb().seed("projects", [{ id: PROJECT, customer_id: ME, project_type: "EMPTY_PLOT", status: "DRAFT", requirements_json: { schemaVersion: 1 } }]);
  ledger = new FakeDb();
  ledger.rpcHandlers.ai_usage_reserve = () => ({ data: "usage-1" });
  ledger.rpcHandlers.ai_usage_finish = () => ({ data: null });
  signedInAs = ME;
  calls = [];
  respond = () => gnaniOk();
  serverClient.mockClear();
  serviceClient.mockClear();
  setEnv(LIVE_ENV);
  transcribeLimiter().reset();
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

describe("live transcription: the documented call, once, through the budget guard", () => {
  it("sends one multipart POST with the documented fields and header, and returns a signed, unlabelled-as-mock transcript", async () => {
    const res = await POST(await multipart(good()), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.vachana.ai/stt/v3");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["X-API-Key-ID"]).toBe(KEY);
    const form = calls[0].init.body as FormData;
    expect([...form.keys()].sort()).toEqual(["audio_file", "language_code"]);
    expect(form.get("language_code")).toBe("ta-IN");
    expect((form.get("audio_file") as File).size).toBeGreaterThan(44);

    const body = await res.json();
    expect(body).toMatchObject({ ok: true, transcript: SPOKEN, mock: false, language: "ta-IN", sourceLanguage: "ta-IN" });
    expect(JSON.stringify(body)).not.toContain(MOCK_TRANSCRIPT_PREFIX);
    const claims = verifyTranscriptToken(body.provenance, { userId: ME, projectId: PROJECT, transcript: SPOKEN }, transcriptVerificationKeys());
    expect(claims).toMatchObject({ source: "gnani", sourceLanguage: "ta-IN" });
  });

  it("reserves credits from the measured duration BEFORE the call and records the outcome after", async () => {
    await POST(await multipart(good()), ctx());
    expect(reservations()).toHaveLength(1);
    expect(reservations()[0].args).toMatchObject({ p_provider: "gnani", p_operation: "stt", p_unit: "credit", p_units: 2, p_customer_id: ME, p_project_id: PROJECT, p_max_in_flight: 1, p_customer_limit: AI_UNMETERED_LIMIT, p_global_limit: 5000, p_global_window_minutes: null });
    expect(finishes()).toHaveLength(1);
    expect(finishes()[0].args).toMatchObject({ p_status: "SUCCEEDED", p_request_id: "req_abc123" });
    // the reservation happened first
    expect(ledger.rpcCalls.map((c) => c.name)).toEqual(["ai_usage_reserve", "ai_usage_finish"]);
  });

  it("never lets a transcript or the key into a response, a log line or the ledger", async () => {
    const res = await POST(await multipart(good()), ctx());
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(TRANSCRIPT_SECRET);
    expect(logs()).not.toContain(SPOKEN);
    expect(logs()).not.toContain(KEY);
    expect(JSON.stringify(ledger.rpcCalls)).not.toContain(SPOKEN);
    expect(JSON.stringify(ledger.rpcCalls)).not.toContain(KEY);
  });

  it("stores nothing: no row and no file is written by the route", async () => {
    await POST(await multipart(good()), ctx());
    expect(db.writes).toHaveLength(0);
    expect(db.uploads).toHaveLength(0);
  });
});

describe("live transcription: a failure is a failure, never a mock", () => {
  const cases: [string, () => Response | Error, number, string][] = [
    ["a Gnani server error", () => new Response("{}", { status: 500 }), 502, "PROVIDER_FAILED"],
    ["a refused key or no credits", () => new Response("{}", { status: 403 }), 502, "PROVIDER_FAILED"],
    ["a provider rate limit", () => new Response("{}", { status: 429 }), 502, "PROVIDER_FAILED"],
    ["success:false in a 200 body", () => Response.json({ success: false, error: { type: "API_ERROR", message: "x" } }), 502, "PROVIDER_FAILED"],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 }), 502, "PROVIDER_FAILED"],
    ["a body without a transcript", () => Response.json({ success: true }), 502, "PROVIDER_FAILED"],
    ["a transcript far over the limit", () => gnaniOk({ transcript: "x".repeat(6000) }), 502, "PROVIDER_FAILED"],
    ["a timeout", () => Object.assign(new Error("t"), { name: "TimeoutError" }), 502, "PROVIDER_FAILED"],
    ["a dropped connection", () => new TypeError("fetch failed"), 502, "PROVIDER_FAILED"],
  ];
  it.each(cases)("answers %s with a safe error, one call, no retry, no mock text", async (_name, make, status, code) => {
    respond = make;
    const res = await POST(await multipart(good()), ctx());
    expect(res.status).toBe(status);
    const body = JSON.stringify(await res.json());
    expect(body).toContain(code);
    expect(body).not.toContain(MOCK_TRANSCRIPT_PREFIX);
    expect(body).not.toContain(KEY);
    expect(calls).toHaveLength(1); // never retried
    // the call was made, so it still counts against the budget
    expect(finishes()[0].args).toMatchObject({ p_status: "FAILED" });
    expect(logs()).not.toContain(KEY);
  });
});

describe("live transcription: a silent recording", () => {
  it.each(["", "   ", "	 "])("is a 422 NO_SPEECH, not a signed empty transcript, and the completed call is still counted (%j)", async (transcript) => {
    respond = () => gnaniOk({ transcript });
    const res = await POST(await multipart(good()), ctx());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("NO_SPEECH");
    expect(body.provenance).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(finishes()[0].args).toMatchObject({ p_status: "SUCCEEDED" });
  });
});

describe("live transcription: refused before any call", () => {
  const noCall = () => {
    expect(calls).toHaveLength(0);
    expect(reservations()).toHaveLength(0);
  };

  it("refuses without consent", async () => {
    const res = await POST(await multipart({ ...good(), consent: "false" }), ctx());
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("CONSENT_REQUIRED");
    noCall();
  });

  it("refuses a language that is not offered", async () => {
    const res = await POST(await multipart({ ...good(), language: "hi-IN" }), ctx());
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("BAD_LANGUAGE");
    noCall();
  });

  it("refuses the demo-only Tanglish selection, which has no provider language code", async () => {
    const res = await POST(await multipart({ ...good(), language: "tanglish-demo" }), ctx());
    expect(res.status).toBe(400);
    noCall();
  });

  it("refuses audio that is not a valid WAV, whatever it is called", async () => {
    const res = await POST(await multipart({ ...good(), audio: new Blob(["ID3 not a wav file at all, only pretending"], { type: "audio/wav" }) }), ctx());
    expect(res.status).toBe(422);
    noCall();
  });

  it("refuses a recording over the maximum duration", async () => {
    const res = await POST(await multipart({ ...good(), audio: wav(31) }), ctx());
    expect([413, 422]).toContain(res.status);
    noCall();
  });

  it("refuses a caller who is not signed in", async () => {
    signedInAs = null;
    expect((await POST(await multipart(good()), ctx())).status).toBe(401);
    noCall();
  });

  it("refuses someone else's project, and says only that it was not found", async () => {
    signedInAs = OTHER;
    const res = await POST(await multipart(good()), ctx());
    expect(res.status).toBe(404);
    noCall();
  });

  it("refuses a project that can no longer be edited", async () => {
    db.tables.projects[0].status = "QUOTED";
    expect((await POST(await multipart(good()), ctx())).status).toBe(409);
    noCall();
  });

  it("is unavailable, never answered by the mock, when a live setting is missing", async () => {
    for (const drop of ["GNANI_API_KEY", "GNANI_STT_ENDPOINT", "GNANI_CREDITS_PER_STT_SECOND", "GNANI_BUDGET_CREDITS", "VOICE_TRANSCRIPT_SECRET", "GNANI_LANGUAGES"]) {
      const { [drop]: _removed, ...rest } = LIVE_ENV as Record<string, string>;
      void _removed;
      setEnv(rest);
      const res = await POST(await multipart(good()), ctx());
      expect(res.status, `without ${drop}`).toBe(503);
      expect(JSON.stringify(await res.json())).not.toContain(MOCK_TRANSCRIPT_PREFIX);
    }
    noCall();
  });

  it("is unavailable for a host that is not the allowed Gnani host, and never calls it", async () => {
    setEnv({ ...LIVE_ENV, GNANI_BASE_URL: "https://api.gnani.ai.evil.example" });
    expect((await POST(await multipart(good()), ctx())).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("makes no call when the budget guard refuses, and reports a safe message", async () => {
    for (const [code, status] of [["AI001", 429], ["AI002", 429], ["AI003", 429]] as const) {
      ledger.rpcHandlers.ai_usage_reserve = () => ({ error: { code, message: "x" } });
      const res = await POST(await multipart(good()), ctx());
      expect(res.status).toBe(status);
      expect(JSON.stringify(await res.json())).not.toMatch(/credit|budget|gnani/i);
      transcribeLimiter().reset();
    }
    expect(calls).toHaveLength(0);
  });

  it("makes no call when the guard is unreachable (fail closed)", async () => {
    ledger.rpcHandlers.ai_usage_reserve = () => ({ error: { message: "db down" } });
    const res = await POST(await multipart(good()), ctx());
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("has no ARCADIA per-request credit maximum: the old setting no longer refuses a recording", async () => {
    setEnv({ ...LIVE_ENV, GNANI_MAX_CREDITS_PER_REQUEST: "1" }); // a 1 s recording is estimated at 2 credits
    const res = await POST(await multipart(good()), ctx());
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(reservations()).toHaveLength(1);
  });

  it("allows only one recording at a time per user, before any credit is reserved", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (globalThis.fetch as unknown as { mockImplementation: (f: unknown) => void }).mockImplementation(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      await gate;
      return gnaniOk();
    });
    const first = POST(await multipart(good()), ctx());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = await POST(await multipart(good()), ctx());
    expect(second.status).toBe(429);
    expect(calls).toHaveLength(1);
    expect(reservations()).toHaveLength(1);
    release();
    expect((await first).status).toBe(200);
  });
});
