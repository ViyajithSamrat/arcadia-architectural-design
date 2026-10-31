import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadReferenceInputs } from "@/lib/generation/references";
import { createBrief } from "@/lib/journeys/service";
import { mockBriefProvider } from "@/lib/journeys/brief";
import type { BriefProvider } from "@/lib/journeys/brief";
import { createMockImageProvider } from "@/lib/providers/mock-image";
import { addReference, listReferences, REFERENCE_MAX_BYTES, REFERENCES_PER_PROJECT, referenceAssetIds, removeReference } from "@/lib/references/service";
import { viewsFor } from "@/lib/generation/prompt";
import { FakeDb } from "./support/fake-supabase";
import { REQUIREMENTS } from "./support/journey-fixtures";

/**
 * Reference photos (PR-010). The fake database does not model row level security or storage
 * policies; those are proved against real Postgres in tests/db/reference-uploads.test.ts. These
 * prove what the APPLICATION does on top of them: ownership, state, the file's real type, limits,
 * the order of writes and what is returned to the browser.
 */

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const SECRET = "client-chosen-name-PRIVATE.png";

let png: Uint8Array;
const jpeg = (w = 640, h = 360, size = 400): Uint8Array => {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
  return b;
};
const webp = (w = 640, h = 360, size = 400): Uint8Array => {
  const b = new Uint8Array(size);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WEBPVP8X"), 8);
  b[24] = (w - 1) & 255; b[25] = ((w - 1) >> 8) & 255; b[26] = 0;
  b[27] = (h - 1) & 255; b[28] = ((h - 1) >> 8) & 255; b[29] = 0;
  return b;
};
const file = (bytes: Uint8Array, name = SECRET) => ({ name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });

let db: FakeDb;
const project = (patch: Record<string, unknown> = {}) => ({ id: PROJECT, customer_id: ME, project_type: "INTERIOR", status: "DRAFT", requirements_json: { schemaVersion: 1 }, ...patch });
const client = () => db.client();
const assets = () => db.rows("design_assets") as { id: string; project_id: string; asset_type: string; storage_path: string; mime_type: string; width: number; height: number; is_released: boolean; generation_job_id: unknown; created_at?: string }[];

beforeEach(async () => {
  const out = await createMockImageProvider().generate({ promptVersion: "p", instructions: "i", views: [viewsFor("INTERIOR")[0]], customerData: {}, requestId: "r", timeoutMs: 1000 });
  png = out.outputs[0].bytes;
  db = new FakeDb().seed("projects", [project(), project({ id: OTHER_PROJECT, customer_id: OTHER })]);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("addReference", () => {
  it("stores the file privately under <project>/references/<random>.<ext> and records an unreleased REFERENCE row", async () => {
    const result = await addReference(client(), ME, PROJECT, file(png));
    expect(result).toMatchObject({ ok: true, asset: { width: 640, height: 360, mimeType: "image/png" } });
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0].path).toMatch(new RegExp(`^${PROJECT}/references/[0-9a-f-]{36}\\.png$`));
    expect(db.uploads[0].contentType).toBe("image/png");
    expect(assets()).toHaveLength(1);
    expect(assets()[0]).toMatchObject({ project_id: PROJECT, asset_type: "REFERENCE", storage_path: db.uploads[0].path, mime_type: "image/png", width: 640, height: 360 });
    expect(assets()[0].is_released ?? false).toBe(false);
    expect(assets()[0].generation_job_id ?? null).toBeNull();
  });

  it("decides the type from the file's own bytes, never from its name or declared type", async () => {
    expect(await addReference(client(), ME, PROJECT, file(jpeg(), "photo.png"))).toMatchObject({ ok: true, asset: { mimeType: "image/jpeg" } });
    expect(await addReference(client(), ME, PROJECT, file(webp(), "photo.jpg"))).toMatchObject({ ok: true, asset: { mimeType: "image/webp" } });
    expect(db.uploads.map((u) => u.path.split(".").pop())).toEqual(["jpg", "webp"]);
    expect(db.uploads.map((u) => u.contentType)).toEqual(["image/jpeg", "image/webp"]);
  });

  it("never puts the client's file name, or anything it sent, into the path or the row", async () => {
    await addReference(client(), ME, PROJECT, file(png, "../../other/evil.png"));
    expect(JSON.stringify([db.uploads, assets(), db.writes])).not.toContain("evil");
    expect(JSON.stringify([db.uploads, assets()])).not.toContain("..");
  });

  it.each([
    ["an SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["a PDF", new TextEncoder().encode("%PDF-1.7 not an image")],
    ["an HTML page named like a photo", new TextEncoder().encode("<html><body>hello</body></html>")],
    ["a GIF", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...new Array(100).fill(0)])],
    ["plain text", new TextEncoder().encode("hello world, this is only text")],
  ])("refuses %s and writes nothing", async (_name, bytes) => {
    const result = await addReference(client(), ME, PROJECT, file(bytes, "photo.jpg"));
    expect(result).toMatchObject({ ok: false, message: "Use a JPEG, PNG or WebP image." });
    expect(db.uploads).toHaveLength(0);
    expect(assets()).toHaveLength(0);
  });

  it("refuses an empty file", async () => {
    expect(await addReference(client(), ME, PROJECT, file(new Uint8Array(0)))).toMatchObject({ ok: false });
    expect(db.uploads).toHaveLength(0);
  });

  it("refuses an oversized file WITHOUT reading it", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const result = await addReference(client(), ME, PROJECT, { size: REFERENCE_MAX_BYTES + 1, arrayBuffer });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/larger than 5 MB/) });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(db.uploads).toHaveLength(0);
  });

  it("refuses an image whose size cannot be read or is outside the allowed range", async () => {
    for (const bytes of [jpeg(32, 32), jpeg(20000, 300), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(50).fill(0)])]) {
      expect(await addReference(client(), ME, PROJECT, file(bytes))).toMatchObject({ ok: false, message: expect.stringMatching(/could not be read, or its size is not allowed/) });
    }
    expect(db.uploads).toHaveLength(0);
  });

  it("allows at most six files per project", async () => {
    for (let i = 0; i < REFERENCES_PER_PROJECT; i += 1) expect((await addReference(client(), ME, PROJECT, file(png))).ok).toBe(true);
    expect(await addReference(client(), ME, PROJECT, file(png))).toMatchObject({ ok: false, message: expect.stringMatching(/up to 6 photos/) });
    expect(assets()).toHaveLength(REFERENCES_PER_PROJECT);
    // another project's count is separate
    db.tables.projects[0].customer_id = ME;
  });

  it("refuses a missing file", async () => {
    expect(await addReference(client(), ME, PROJECT, null)).toMatchObject({ ok: false });
  });

  it("tells a stranger, an unknown id and a malformed id only that the project was not found, and writes nothing", async () => {
    for (const [who, id] of [[OTHER, PROJECT], [ME, "55555555-5555-4555-8555-555555555555"], [ME, "not-a-uuid"], [ME, undefined], [ME, "../etc"]] as const) {
      expect(await addReference(client(), who, id, file(png))).toEqual({ ok: false, message: "We could not find that project." });
    }
    expect(db.uploads).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  it("takes no reference photos for a new build", async () => {
    db.tables.projects[0].project_type = "EMPTY_PLOT";
    expect(await addReference(client(), ME, PROJECT, file(png))).toMatchObject({ ok: false, message: "This kind of project does not take reference photos." });
    expect(db.uploads).toHaveLength(0);
  });

  it.each(["BRIEF_APPROVED", "QUOTED", "AWAITING_PAYMENT", "PAYMENT_VERIFIED", "GENERATING", "READY_FOR_REVIEW", "RELEASED", "CANCELLED"])("refuses to add a photo once the project is %s", async (status) => {
    db.tables.projects[0].status = status;
    expect(await addReference(client(), ME, PROJECT, file(png))).toMatchObject({ ok: false });
    expect(db.uploads).toHaveLength(0);
    expect(assets()).toHaveLength(0);
  });

  it.each(["DRAFT", "TRANSCRIPT_READY", "BRIEF_REVIEW"])("allows adding while the project is %s", async (status) => {
    db.tables.projects[0].status = status;
    expect((await addReference(client(), ME, PROJECT, file(png))).ok).toBe(true);
  });

  it("uploads before it records, and removes the file again if the record fails: no misleading row, no orphan", async () => {
    db.failNext = { table: "design_assets", op: "insert" };
    const result = await addReference(client(), ME, PROJECT, file(png));
    expect(result).toMatchObject({ ok: false });
    const order = db.writes.map((w) => `${w.table}.${w.op}`);
    expect(order).toEqual(["design_assets.insert"]);
    expect(db.uploads).toHaveLength(1);
    expect(db.removals).toEqual([db.uploads[0].path]);
    expect(assets()).toHaveLength(0);
  });

  it("records nothing when the upload itself fails", async () => {
    db.failUpload = true;
    expect(await addReference(client(), ME, PROJECT, file(png))).toMatchObject({ ok: false });
    expect(assets()).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  it("uses only the caller's own session: the service role is never involved", async () => {
    // The functions take a single client. Whatever it is allowed to do, RLS decides: prove the call shape.
    const seen: string[] = [];
    const real = client();
    const spy = new Proxy(real, { get: (t, p) => { seen.push(String(p)); return (t as never)[p]; } });
    await addReference(spy as SupabaseClient, ME, PROJECT, file(png));
    expect(seen.filter((s) => s === "rpc")).toEqual([]);
  });
});

describe("listReferences", () => {
  const seed = async () => {
    await addReference(client(), ME, PROJECT, file(png));
    await addReference(client(), ME, PROJECT, file(jpeg()));
  };

  it("lists the project's own photos with short-lived signed links, and never a storage path", async () => {
    await seed();
    const items = (await listReferences(client(), ME, PROJECT))!;
    expect(items).toHaveLength(2);
    expect(db.signed.map((s) => s.seconds)).toEqual([300, 300]);
    expect(items.every((i) => i.url?.startsWith("https://signed.test/"))).toBe(true);
    expect(Object.keys(items[0]).sort()).toEqual(["createdAt", "height", "id", "url", "width"]);
    // the path appears only inside the signed link the fake builds, never as a field of its own
    expect(JSON.stringify(items.map((i) => ({ id: i.id, width: i.width, height: i.height, createdAt: i.createdAt })))).not.toMatch(/references\//);
  });

  it("lists only REFERENCE rows: payment proof and generated files never appear", async () => {
    await seed();
    db.seed("design_assets", [
      { id: "p1", project_id: PROJECT, asset_type: "PAYMENT_PROOF", storage_path: `${PROJECT}/payment-proofs/x.png`, width: 1, height: 1, created_at: "2026-10-21T00:00:00Z" },
      { id: "g1", project_id: PROJECT, asset_type: "EXTERIOR_CONCEPT", storage_path: `${PROJECT}/generated/x.png`, width: 1, height: 1, created_at: "2026-10-21T00:00:00Z" },
    ]);
    const items = (await listReferences(client(), ME, PROJECT))!;
    expect(items.map((i) => i.id)).not.toContain("p1");
    expect(items.map((i) => i.id)).not.toContain("g1");
    expect(items).toHaveLength(2);
  });

  it("signs only a path that is exactly <this project>/references/<file>", async () => {
    db.seed("design_assets", [
      { id: "a1", project_id: PROJECT, asset_type: "REFERENCE", storage_path: `${OTHER_PROJECT}/references/stolen.png`, width: 10, height: 10, created_at: "2026-10-21T00:00:00Z" },
      { id: "a2", project_id: PROJECT, asset_type: "REFERENCE", storage_path: `${PROJECT}/payment-proofs/proof.png`, width: 10, height: 10, created_at: "2026-10-21T00:00:01Z" },
      { id: "a3", project_id: PROJECT, asset_type: "REFERENCE", storage_path: `${PROJECT}/references/../../secret.png`, width: 10, height: 10, created_at: "2026-10-21T00:00:02Z" },
    ]);
    const items = (await listReferences(client(), ME, PROJECT))!;
    expect(items.map((i) => i.url)).toEqual([null, null, null]);
    expect(db.signed).toHaveLength(0);
  });

  it("returns null for a stranger, an unknown project, a new build, and a failed read", async () => {
    expect(await listReferences(client(), OTHER, PROJECT)).toBeNull();
    expect(await listReferences(client(), ME, "55555555-5555-4555-8555-555555555555")).toBeNull();
    db.tables.projects[0].project_type = "EMPTY_PLOT";
    expect(await listReferences(client(), ME, PROJECT)).toBeNull();
  });

  it("still lists photos after the project is no longer editable (read-only)", async () => {
    await seed();
    db.tables.projects[0].status = "QUOTED";
    expect(await listReferences(client(), ME, PROJECT)).toHaveLength(2);
  });
});

describe("removeReference", () => {
  const add = async () => {
    await addReference(client(), ME, PROJECT, file(png));
    return assets()[0];
  };

  it("deletes the row first and then the file, for the owner's own photo", async () => {
    const asset = await add();
    db.writes.length = 0;
    expect(await removeReference(client(), ME, PROJECT, asset.id)).toEqual({ ok: true });
    expect(assets()).toHaveLength(0);
    expect(db.removals).toEqual([asset.storage_path]);
    expect(db.writes.map((w) => `${w.table}.${w.op}`)).toEqual(["design_assets.delete"]);
  });

  it("keeps the file when the row cannot be deleted, so no record ever points at a missing file", async () => {
    const asset = await add();
    db.failNext = { table: "design_assets", op: "delete" };
    expect(await removeReference(client(), ME, PROJECT, asset.id)).toMatchObject({ ok: false });
    expect(assets()).toHaveLength(1);
    expect(db.removals).toEqual([]);
  });

  it("refuses a photo of another project or another type, and a bad id", async () => {
    const asset = await add();
    db.seed("design_assets", [{ id: "99999999-9999-4999-8999-999999999999", project_id: PROJECT, asset_type: "PAYMENT_PROOF", storage_path: `${PROJECT}/payment-proofs/p.png` }]);
    expect(await removeReference(client(), ME, OTHER_PROJECT, asset.id)).toMatchObject({ ok: false });
    expect(await removeReference(client(), OTHER, PROJECT, asset.id)).toMatchObject({ ok: false });
    expect(await removeReference(client(), ME, PROJECT, "99999999-9999-4999-8999-999999999999")).toEqual({ ok: false, message: "That photo was not found." });
    expect(await removeReference(client(), ME, PROJECT, "nope")).toEqual({ ok: false, message: "That photo was not found." });
    expect(await removeReference(client(), ME, PROJECT, undefined)).toMatchObject({ ok: false });
    expect(assets()).toHaveLength(2);
    expect(db.removals).toEqual([]);
  });

  it("refuses to remove once the project is no longer editable", async () => {
    const asset = await add();
    db.tables.projects[0].status = "QUOTED";
    expect(await removeReference(client(), ME, PROJECT, asset.id)).toMatchObject({ ok: false });
    expect(assets()).toHaveLength(1);
    expect(db.removals).toEqual([]);
  });

  it("refuses a row whose stored path does not belong to this project, and removes nothing", async () => {
    db.seed("design_assets", [{ id: "88888888-8888-4888-8888-888888888888", project_id: PROJECT, asset_type: "REFERENCE", storage_path: `${OTHER_PROJECT}/references/x.png` }]);
    expect(await removeReference(client(), ME, PROJECT, "88888888-8888-4888-8888-888888888888")).toMatchObject({ ok: false });
    expect(db.removals).toEqual([]);
    expect(assets()).toHaveLength(1);
  });
});

describe("referenceAssetIds and the brief", () => {
  it("lists the ids of the project's reference files, oldest first", async () => {
    await addReference(client(), ME, PROJECT, file(png));
    await addReference(client(), ME, PROJECT, file(jpeg()));
    expect(await referenceAssetIds(client(), PROJECT)).toEqual(assets().map((a) => a.id));
  });

  const requirementsFor = (type: "INTERIOR" | "LANDSCAPE" | "EMPTY_PLOT") => REQUIREMENTS[type];
  const draft = (type: "INTERIOR" | "LANDSCAPE" | "EMPTY_PLOT") => {
    db.tables.projects[0].project_type = type;
    db.tables.projects[0].requirements_json = requirementsFor(type);
  };
  const run = (provider: BriefProvider) => createBrief(client(), client(), ME, PROJECT, provider);
  const stored = () => (db.tables.projects[0] as { english_brief_json: { referenceAssetIds: string[]; missingOptionalDetails: string[] } }).english_brief_json;

  it("records the project's real reference ids in the brief, and drops any ids a producer made up", async () => {
    draft("INTERIOR");
    await addReference(client(), ME, PROJECT, file(png));
    const forged: BriefProvider = { id: "mock", generate: async (input) => ({ ...(await mockBriefProvider.generate(input)) as object, referenceAssetIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] }) };
    expect(await run(forged)).toEqual({ ok: true });
    expect(stored().referenceAssetIds).toEqual([assets()[0].id]);
  });

  it("tells the producer how many photos there are, and stops listing the missing photos as a gap when some exist", async () => {
    draft("INTERIOR");
    let counts: (number | undefined)[] = [];
    const spy: BriefProvider = { id: "mock", generate: async (input) => { counts.push(input.referenceCount); return mockBriefProvider.generate(input); } };
    await run(spy);
    expect(counts).toEqual([0]);
    expect(stored().missingOptionalDetails.join(" ")).toMatch(/none uploaded/);
    await addReference(client(), ME, PROJECT, file(png));
    counts = [];
    await run(spy);
    expect(counts).toEqual([1]);
    expect(stored().missingOptionalDetails.join(" ")).not.toMatch(/none uploaded/);
  });

  it("records no references for a new build, whatever files exist", async () => {
    draft("EMPTY_PLOT");
    db.seed("design_assets", [{ id: "77777777-7777-4777-8777-777777777777", project_id: PROJECT, asset_type: "REFERENCE", storage_path: `${PROJECT}/references/x.png` }]);
    expect(await run(mockBriefProvider)).toEqual({ ok: true });
    expect(stored().referenceAssetIds).toEqual([]);
  });
});

describe("loadReferenceInputs (what an image provider may be given)", () => {
  const withStorage = (files: Record<string, Uint8Array | null>) => {
    const c = db.client() as unknown as { storage: { from: () => Record<string, unknown> } };
    c.storage.from = () => ({
      download: async (path: string) => {
        const bytes = files[path];
        return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: "gone" } };
      },
    });
    return c as unknown as SupabaseClient;
  };
  const row = (id: string, path: string, at: string) => ({ id, project_id: PROJECT, asset_type: "REFERENCE", storage_path: path, created_at: at });

  it("returns real images of this project only, checking the bytes again, at most three, oldest first", async () => {
    const good = (n: number) => `${PROJECT}/references/0000000${n}-0000-4000-8000-000000000000.png`;
    db.seed("design_assets", [
      row("1", good(1), "2026-10-21T00:00:01Z"), row("2", good(2), "2026-10-21T00:00:02Z"), row("3", good(3), "2026-10-21T00:00:03Z"), row("4", good(4), "2026-10-21T00:00:04Z"),
    ]);
    const out = await loadReferenceInputs(withStorage({ [good(1)]: png, [good(2)]: jpeg(), [good(3)]: webp(), [good(4)]: png }), PROJECT);
    expect(out.map((o) => o.mimeType)).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

  it("skips a row pointing at another project, a bad path, a non-image, an empty file and an oversized one", async () => {
    const own = (name: string) => `${PROJECT}/references/${name}`;
    db.seed("design_assets", [
      row("1", `${OTHER_PROJECT}/references/a.png`, "2026-10-21T00:00:01Z"),
      row("2", own("b.txt"), "2026-10-21T00:00:02Z"),
      row("3", `${PROJECT}/payment-proofs/c.png`, "2026-10-21T00:00:03Z"),
    ]);
    const out = await loadReferenceInputs(withStorage({ [`${OTHER_PROJECT}/references/a.png`]: png, [own("b.txt")]: new TextEncoder().encode("not an image at all"), [`${PROJECT}/payment-proofs/c.png`]: png }), PROJECT);
    expect(out).toEqual([]);
    db.tables.design_assets = [row("5", own("e.png"), "2026-10-21T00:00:05Z"), row("6", own("f.png"), "2026-10-21T00:00:06Z")];
    const big = new Uint8Array(REFERENCE_MAX_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(await loadReferenceInputs(withStorage({ [own("e.png")]: new Uint8Array(0), [own("f.png")]: big }), PROJECT)).toEqual([]);
  });

  it("returns nothing when the read fails", async () => {
    const failing = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "x" } }) }) }) }) }) }) } as unknown as SupabaseClient;
    expect(await loadReferenceInputs(failing, PROJECT)).toEqual([]);
  });
});
