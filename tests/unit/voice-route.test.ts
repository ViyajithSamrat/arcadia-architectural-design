import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_TRANSCRIPT_PREFIX } from "@/lib/providers/mock-speech";
import { encodeWav } from "@/lib/voice/wav-encode";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const SECRET = "gnani-SECRET-value-never-shown";

let db: FakeDb;
let signedInAs: string | null;
const serverClient = vi.fn(async (): Promise<SupabaseClient> => {
  const client = db.client() as unknown as Record<string, unknown>;
  client.auth = { getUser: async () => (signedInAs ? { data: { user: { id: signedInAs } }, error: null } : { data: { user: null }, error: { message: "no session" } }) };
  return client as unknown as SupabaseClient;
});
const serviceClient = vi.fn(() => {
  throw new Error("no trusted client is available in this test");
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => serverClient() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: () => serviceClient() }));

const { POST } = await import("@/app/api/projects/[id]/transcribe/route");
const { getVoiceMode } = await import("@/lib/journeys/voice");
const { transcribeLimiter, TRANSCRIBE_LIMITS } = await import("@/lib/voice/rate-limit");
const { transcriptVerificationKeys, verifyTranscriptToken } = await import("@/lib/voice/provenance");

const ENV_KEYS = ["GNANI_VOICE_ENABLED", "GNANI_API_KEY", "GNANI_BASE_URL", "GNANI_STT_ENDPOINT", "GNANI_LANGUAGES", "GNANI_CREDITS_PER_STT_SECOND", "GNANI_MAX_CREDITS_PER_REQUEST", "GNANI_CUSTOMER_CREDITS_PER_HOUR", "GNANI_BUDGET_CREDITS", "GNANI_STT_MAX_SECONDS", "VOICE_TRANSCRIPT_SECRET"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const setEnv = (values: Record<string, string>) => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
};

const URL_ = `http://localhost:3000/api/projects/${PROJECT}/transcribe`;
const ctx = (id = PROJECT) => ({ params: Promise.resolve({ id }) });
const wav = (seconds: number) => new Blob([encodeWav(new Float32Array(Math.round(seconds * 16_000)), 16_000) as BlobPart], { type: "audio/wav" });

/** A real multipart request with its size declared, as a browser sends it. */
async function multipart(fields: Record<string, string | Blob>, headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const draft = new Request(URL_, { method: "POST", body: form });
  const body = await draft.arrayBuffer();
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": draft.headers.get("content-type")!, "content-length": String(body.byteLength), ...headers },
    body,
  });
}
const good = () => ({ language: "ta-IN", consent: "true", audio: wav(1) });

const logs = () => [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls].flat().map(String).join("\n");

beforeEach(() => {
  db = new FakeDb().seed("projects", [{ id: PROJECT, customer_id: ME, project_type: "EMPTY_PLOT", status: "DRAFT", requirements_json: { schemaVersion: 1 } }]);
  signedInAs = ME;
  serverClient.mockClear();
  serviceClient.mockClear();
  setEnv({ GNANI_VOICE_ENABLED: "mock", GNANI_API_KEY: SECRET });
  transcribeLimiter().reset();
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const expectNoStore = (res: Response) => expect(res.headers.get("cache-control")).toBe("no-store");

describe("POST /api/projects/[id]/transcribe: refusals before the body is read", () => {
  it("rejects a cross-origin request", async () => {
    const res = await POST(await multipart(good(), { origin: "https://evil.example" }), ctx());
    expect(res.status).toBe(403);
    expectNoStore(res);
    expect(serverClient).not.toHaveBeenCalled();
  });

  it("says voice is off when it is off, and unavailable for an invalid or live setting, without signing in or reading", async () => {
    setEnv({});
    expect((await POST(await multipart(good()), ctx())).status).toBe(404);
    setEnv({ GNANI_VOICE_ENABLED: "banana" });
    expect((await POST(await multipart(good()), ctx())).status).toBe(503);
    // a live configuration whose trusted ledger client cannot be created is unavailable, and nothing reaches the network
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setEnv({
      GNANI_VOICE_ENABLED: "true", GNANI_API_KEY: SECRET, GNANI_BASE_URL: "https://api.vachana.ai", GNANI_STT_ENDPOINT: "/stt/v3", GNANI_LANGUAGES: "ta-IN",
      GNANI_CREDITS_PER_STT_SECOND: "2", GNANI_MAX_CREDITS_PER_REQUEST: "100", GNANI_CUSTOMER_CREDITS_PER_HOUR: "300", GNANI_BUDGET_CREDITS: "1000",
      VOICE_TRANSCRIPT_SECRET: "route-test-transcript-SECRET-0123456789",
    });
    // Complete in every respect, so only the missing ledger client (the service key) can refuse it.
    expect(getVoiceMode().kind).toBe("live");
    const res = await POST(await multipart(good()), ctx());
    expect(res.status).toBe(503);
    expectNoStore(res);
    const refusal = JSON.stringify(await res.json());
    expect(refusal).not.toContain(SECRET);
    expect(refusal).not.toContain("route-test-transcript-SECRET");
    expect(refusal).toContain("VOICE_UNAVAILABLE");
    expect(refusal).not.toContain(MOCK_TRANSCRIPT_PREFIX); // never answered by the mock
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(serviceClient).toHaveBeenCalledTimes(1);
  });

  it("requires a declared size and refuses one over the limit before signing in or reading the body", async () => {
    const noLength = new Request(URL_, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "x" });
    expect((await POST(noLength, ctx())).status).toBe(411);
    let pulled = false;
    // highWaterMark 0: the stream is pulled only when something actually reads the body.
    const stream = new ReadableStream(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const huge = new Request(URL_, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(10 * 1024 * 1024) }, body: stream, duplex: "half" } as RequestInit);
    const res = await POST(huge, ctx());
    expect(res.status).toBe(413);
    expectNoStore(res);
    expect(pulled).toBe(false);
    expect(serverClient).not.toHaveBeenCalled();
  });

  it("refuses anything but a multipart form", async () => {
    const json = new Request(URL_, { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" });
    expect((await POST(json, ctx())).status).toBe(415);
  });

  it("refuses a caller who is not signed in", async () => {
    signedInAs = null;
    const res = await POST(await multipart(good()), ctx());
    expect(res.status).toBe(401);
    expectNoStore(res);
  });
});

describe("POST /api/projects/[id]/transcribe: the service's checks", () => {
  it("requires consent", async () => {
    const res = await POST(await multipart({ ...good(), consent: "yes" }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("CONSENT_REQUIRED");
  });

  it("refuses someone else's project and a project that can no longer be edited", async () => {
    signedInAs = OTHER;
    expect((await POST(await multipart(good()), ctx())).status).toBe(404);
    signedInAs = ME;
    db.tables.projects[0].status = "QUOTED";
    expect((await POST(await multipart(good()), ctx())).status).toBe(409);
  });

  it("refuses a file that is not a valid WAV, whatever it is called", async () => {
    const fake = new Blob([new TextEncoder().encode("RIFF but not really")], { type: "audio/wav" });
    const res = await POST(await multipart({ ...good(), audio: fake }), ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("BAD_AUDIO");
  });

  it("returns the labelled mock transcript to the owner, logs nothing, stores nothing and leaks no secret", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(await multipart(good()), ctx());
    expect(res.status).toBe(200);
    expectNoStore(res);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mock: true, language: "ta-IN", sourceLanguage: "ta-IN", seconds: 1, truncated: false });
    // The provenance token vouches for exactly this transcript, for this user and project, as a mock.
    expect(verifyTranscriptToken(body.provenance, { userId: ME, projectId: PROJECT, transcript: body.transcript }, transcriptVerificationKeys({}))).toMatchObject({ source: "mock" });
    expect(body.transcript.startsWith(MOCK_TRANSCRIPT_PREFIX)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(logs()).not.toContain("MOCK TRANSCRIPT");
    expect(logs()).not.toContain(SECRET);
    expect(db.writes).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("error responses carry a code and a customer-safe message only", async () => {
    signedInAs = OTHER;
    const body = await (await POST(await multipart(good()), ctx())).json();
    expect(body).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "We could not find that project." } });
  });
});

describe("POST /api/projects/[id]/transcribe: rate limit (R1-B)", () => {
  it("allows a limited number of recordings per user per minute, then refuses with Retry-After before reading the body", async () => {
    for (let i = 0; i < TRANSCRIBE_LIMITS.maxPerWindow; i++) expect((await POST(await multipart(good()), ctx())).status).toBe(200);
    let pulled = false;
    const stream = new ReadableStream({ pull() { pulled = true; } }, { highWaterMark: 0 });
    const next = new Request(URL_, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "100" }, body: stream, duplex: "half" } as RequestInit);
    const res = await POST(next, ctx());
    expect(res.status).toBe(429);
    expectNoStore(res);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
    expect(pulled).toBe(false);
  });

  it("counts each signed-in user separately: one user's limit does not block another", async () => {
    for (let i = 0; i < TRANSCRIBE_LIMITS.maxPerWindow; i++) await POST(await multipart(good()), ctx());
    expect((await POST(await multipart(good()), ctx())).status).toBe(429);
    signedInAs = OTHER;
    // OTHER is not limited; the project is not theirs, so the service answers 404, not 429.
    expect((await POST(await multipart(good()), ctx())).status).toBe(404);
  });

  it("handles one recording per user at a time", async () => {
    // The first request's body arrives only when released, so it is still in flight (after sign-in,
    // holding its slot) when the second one comes in.
    const ready = await multipart(good());
    const bytes = new Uint8Array(await ready.arrayBuffer());
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stream = new ReadableStream({
      async start(controller) {
        await gate;
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const slow = new Request(URL_, { method: "POST", headers: { "content-type": ready.headers.get("content-type")!, "content-length": String(bytes.byteLength) }, body: stream, duplex: "half" } as RequestInit);
    const first = POST(slow, ctx());
    await new Promise((r) => setTimeout(r, 20)); // let the first request sign in and take its slot
    const second = await POST(await multipart(good()), ctx());
    expect(second.status).toBe(429);
    expect((await second.json()).error.code).toBe("BUSY");
    release();
    expect((await first).status).toBe(200);
    // The slot is given back once a request finishes, also after a refusal by the service.
    expect((await POST(await multipart({ ...good(), consent: "no" }), ctx())).status).toBe(400);
    expect((await POST(await multipart(good()), ctx())).status).toBe(200);
  });

  it("is applied only after sign-in, so a caller who is not signed in uses no one's allowance", async () => {
    signedInAs = null;
    for (let i = 0; i < TRANSCRIBE_LIMITS.maxPerWindow + 2; i++) expect((await POST(await multipart(good()), ctx())).status).toBe(401);
    signedInAs = ME;
    expect((await POST(await multipart(good()), ctx())).status).toBe(200);
  });
});
