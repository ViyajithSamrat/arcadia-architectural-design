import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockImageProvider } from "@/lib/providers/mock-image";
import { viewsFor } from "@/lib/generation/prompt";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const FILE_NAME = "my-private-holiday-photo.png";

let db: FakeDb;
let signedInAs: string | null;
const serverClient = vi.fn(async (): Promise<SupabaseClient> => {
  const client = db.client() as unknown as Record<string, unknown>;
  client.auth = { getUser: async () => (signedInAs ? { data: { user: { id: signedInAs } }, error: null } : { data: { user: null }, error: { message: "no session" } }) };
  return client as unknown as SupabaseClient;
});
const serviceClient = vi.fn(() => {
  throw new Error("the service client must never be used for reference photos");
});
const revalidatePath = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => serverClient() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: () => serviceClient() }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));

const { POST } = await import("@/app/api/projects/[id]/references/route");
const { removeReferenceAction } = await import("@/app/(app)/projects/actions");
const { referenceLimiter, REFERENCE_UPLOAD_LIMITS } = await import("@/lib/references/limiter");

let png: Uint8Array;
const URL_ = `http://localhost:3000/api/projects/${PROJECT}/references`;
const ctx = (id = PROJECT) => ({ params: Promise.resolve({ id }) });

async function multipart(fields: Record<string, string | Blob>, headers: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") form.append(k, v);
    else form.append(k, v, FILE_NAME);
  }
  const draft = new Request(URL_, { method: "POST", body: form });
  const body = await draft.arrayBuffer();
  return new Request(URL_, { method: "POST", headers: { "content-type": draft.headers.get("content-type")!, "content-length": String(body.byteLength), ...headers }, body });
}
const photo = (bytes?: Uint8Array) => new Blob([(bytes ?? png) as BlobPart], { type: "image/png" });
const logs = () => [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls].flat().map(String).join("\n");
const assets = () => db.rows("design_assets") as { storage_path: string; asset_type: string }[];

beforeEach(async () => {
  const out = await createMockImageProvider().generate({ promptVersion: "p", instructions: "i", views: [viewsFor("INTERIOR")[0]], customerData: {}, requestId: "r", timeoutMs: 1000 });
  png = out.outputs[0].bytes;
  db = new FakeDb().seed("projects", [{ id: PROJECT, customer_id: ME, project_type: "INTERIOR", status: "DRAFT", requirements_json: { schemaVersion: 1 } }]);
  signedInAs = ME;
  serverClient.mockClear();
  serviceClient.mockClear();
  revalidatePath.mockClear();
  referenceLimiter().reset();
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/projects/[id]/references", () => {
  it("stores a valid photo privately for the owner and answers 201 without any storage path", async () => {
    const res = await POST(await multipart({ file: photo() }), ctx());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, asset: { width: 640, height: 360, mimeType: "image/png" } });
    expect(JSON.stringify(body)).not.toMatch(/references\/|storage|path/i);
    expect(assets()).toHaveLength(1);
    expect(assets()[0].storage_path).toMatch(new RegExp(`^${PROJECT}/references/[0-9a-f-]{36}\\.png$`));
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("never lets the file name reach the path, a row, the response or a log", async () => {
    const res = await POST(await multipart({ file: photo() }), ctx());
    const everything = JSON.stringify([await res.json(), db.uploads, db.rows("design_assets"), db.writes]) + logs();
    expect(everything).not.toContain("holiday");
    expect(everything).not.toContain(FILE_NAME);
  });

  it("refuses a cross-origin request before anything else", async () => {
    const res = await POST(await multipart({ file: photo() }, { origin: "https://evil.example" }), ctx());
    expect(res.status).toBe(403);
    expect(serverClient).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
  });

  it("requires a declared size within the limit and a multipart form, before signing in or reading the body", async () => {
    expect((await POST(new Request(URL_, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: "x" }), ctx())).status).toBe(411);
    const big = new Request(URL_, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(6 * 1024 * 1024) }, body: "x" });
    expect((await POST(big, ctx())).status).toBe(413);
    const wrong = new Request(URL_, { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" });
    expect((await POST(wrong, ctx())).status).toBe(415);
    expect(serverClient).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not signed in", async () => {
    signedInAs = null;
    expect((await POST(await multipart({ file: photo() }), ctx())).status).toBe(401);
    expect(db.writes).toHaveLength(0);
    expect(db.uploads).toHaveLength(0);
  });

  it("says only that the project was not found for a stranger or an unknown id, and writes nothing", async () => {
    signedInAs = OTHER;
    const res = await POST(await multipart({ file: photo() }), ctx());
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("could not find that project");
    expect(db.uploads).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a missing file, and a file that is not a JPEG, PNG or WebP whatever it is called", async () => {
    expect((await POST(await multipart({ other: "x" }), ctx())).status).toBe(422);
    const res = await POST(await multipart({ file: new Blob([new TextEncoder().encode("<svg onload=alert(1)>")], { type: "image/png" }) }), ctx());
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("Use a JPEG, PNG or WebP image.");
    expect(db.uploads).toHaveLength(0);
  });

  it("limits each user to a number of uploads a minute, before reading the body", async () => {
    for (let i = 0; i < REFERENCE_UPLOAD_LIMITS.maxPerWindow; i += 1) {
      db.tables.design_assets = [];
      expect((await POST(await multipart({ file: photo() }), ctx())).status).toBe(201);
    }
    const limited = await POST(await multipart({ file: photo() }), ctx());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});

describe("removeReferenceAction", () => {
  const seed = async () => {
    await POST(await multipart({ file: photo() }), ctx());
    return (db.rows("design_assets")[0] as { id: string }).id;
  };

  it("removes the owner's photo and refreshes only the edit page", async () => {
    const id = await seed();
    expect(await removeReferenceAction(PROJECT, id)).toBeUndefined();
    expect(db.rows("design_assets")).toHaveLength(0);
    expect(db.removals).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${PROJECT}/edit`);
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("refuses malformed ids and a caller who is not signed in, and changes nothing", async () => {
    const id = await seed();
    expect(await removeReferenceAction("nope", id)).toMatchObject({ ok: false, message: "That request was not valid." });
    expect(await removeReferenceAction(PROJECT, "nope")).toMatchObject({ ok: false });
    signedInAs = null;
    expect(await removeReferenceAction(PROJECT, id)).toMatchObject({ ok: false });
    expect(db.rows("design_assets")).toHaveLength(1);
    expect(db.removals).toHaveLength(0);
  });

  it("refuses someone else's project", async () => {
    const id = await seed();
    signedInAs = OTHER;
    expect(await removeReferenceAction(PROJECT, id)).toMatchObject({ ok: false });
    expect(db.rows("design_assets")).toHaveLength(1);
  });
});
