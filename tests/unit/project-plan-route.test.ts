import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./support/fake-supabase";
import { storedRequirements } from "./support/journey-fixtures";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

let db: FakeDb;
let signedInAs: string | null;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => {
    const client = db.client() as unknown as Record<string, unknown>;
    client.auth = { getUser: async () => (signedInAs ? { data: { user: { id: signedInAs } }, error: null } : { data: { user: null }, error: { message: "no session" } }) };
    return client as unknown as SupabaseClient;
  },
}));
// The drawing is built from the owner's saved answers; the trusted client has no part in it.
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: () => {
    throw new Error("the service client must never be used for the drawing download");
  },
}));

const { GET } = await import("@/app/api/projects/[id]/plan/route");
const get = (query = "", id = PROJECT) => GET(new Request(`http://localhost:3000/api/projects/${id}/plan${query}`), { params: Promise.resolve({ id }) });

const project = (over: Record<string, unknown> = {}) =>
  db.seed("projects", [{ id: PROJECT, customer_id: ME, project_type: "EMPTY_PLOT", status: "RELEASED", requirements_json: storedRequirements("EMPTY_PLOT"), ...over }]);

beforeEach(() => {
  db = new FakeDb();
  signedInAs = ME;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/projects/[id]/plan", () => {
  it("gives the owner of a released project a real DXF file, with the customer's plot size inside it", async () => {
    project();
    const res = await get("?format=dxf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/dxf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="arcadia-layout-333333.dxf"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body.startsWith("0\r\nSECTION\r\n2\r\nHEADER")).toBe(true);
    expect(body.endsWith("0\r\nEOF\r\n")).toBe(true);
    expect(body).toContain("Plot width 30 ft");
    expect(body).toContain("Plot length 40 ft");
    expect(body).toContain("Living room");
  });

  it("defaults to DXF, and also offers the sketch as SVG, floor by floor", async () => {
    project();
    expect((await get()).headers.get("content-type")).toBe("application/dxf");
    const svg = await get("?format=svg&floor=2");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(svg.headers.get("content-disposition")).toBe('attachment; filename="arcadia-layout-333333-floor-2.svg"');
    const text = await svg.text();
    expect(text.startsWith("<svg")).toBe(true);
    expect(text).toContain("First floor");
    expect(text).not.toContain("<script");
  });

  it("is refused to someone not signed in", async () => {
    project();
    signedInAs = null;
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("SECTION");
  });

  it("treats another customer's project exactly like a missing one", async () => {
    project();
    signedInAs = OTHER;
    const other = await get();
    signedInAs = ME;
    const missing = await get("", "55555555-5555-4555-8555-555555555555");
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    expect((await get("", "not-a-uuid")).status).toBe(404);
  });

  it.each(["DRAFT", "AWAITING_PAYMENT", "PAYMENT_VERIFIED", "GENERATING", "GENERATION_FAILED", "READY_FOR_REVIEW", "CANCELLED"])("gives the owner no drawing while the project is %s", async (status) => {
    project({ status });
    const res = await get();
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).not.toMatch(/SECTION|<svg|Plot width/);
  });

  it.each(["INTERIOR", "LANDSCAPE"] as const)("has no layout drawing for a %s project, and says so", async (type) => {
    project({ project_type: type, requirements_json: storedRequirements(type) });
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_AVAILABLE");
  });

  it("does not invent a drawing from answers that are missing or invalid", async () => {
    project({ requirements_json: { schemaVersion: 1 } });
    expect((await get()).status).toBe(404);
  });

  it.each(["?format=pdf", "?format=", "?format=dxf&floor=0", "?format=dxf&floor=10", "?format=svg&floor=abc", "?format=svg&floor=9"])("rejects the invalid request %s without a file", async (query) => {
    project();
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/SECTION|<svg/);
  });
});
