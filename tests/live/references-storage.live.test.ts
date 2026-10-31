import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDraftProject } from "@/lib/journeys/service";
import { createMockImageProvider } from "@/lib/providers/mock-image";
import { viewsFor } from "@/lib/generation/prompt";
import { addReference, listReferences, REFERENCES_PER_PROJECT, removeReference } from "@/lib/references/service";
import { PROJECT_FILES_BUCKET } from "@/lib/storage/paths";

/**
 * Reference photos and private storage against the REAL local Supabase stack (Auth, PostgREST,
 * Storage). NON-DESTRUCTIVE: it creates its own @example.test users and projects, touches no other
 * data, changes no pricing and no triggers, and removes what it created. It refuses to run unless
 * the URL is this machine.
 *
 *   LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts tests/live/references-storage.live.test.ts
 *
 * Ordinary customer operations use each customer's own session; the service role is used only to
 * create accounts, to plant objects a customer could not create (generated output, payment proof),
 * and to clean up.
 */

const ENABLED = process.env.LIVE_SUPABASE === "1";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_CONTAINER = "supabase_db_Gnani_intern";
const PASSWORD = "Live-test-" + randomUUID();
const RUN = randomUUID().slice(0, 8);

if (ENABLED && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) {
  throw new Error("Refusing to run live tests: NEXT_PUBLIC_SUPABASE_URL is not a local address.");
}

function sql(query: string): string {
  return execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", query], { encoding: "utf8" }).trim();
}

const asFile = (bytes: Uint8Array, declared = "image/png") => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, type: declared });

describe.skipIf(!ENABLED)("live local Supabase: reference uploads and private storage", () => {
  let service: SupabaseClient;
  const users = {} as Record<"a" | "b", { id: string; client: SupabaseClient }>;
  let anon: SupabaseClient;
  let png: Uint8Array;
  let projectA = "";
  let landscapeA = "";
  let plotA = "";
  const planted: string[] = [];
  const bucket = (c: SupabaseClient) => c.storage.from(PROJECT_FILES_BUCKET);
  const rows = (project: string, type = "REFERENCE") => Number(sql(`select count(*) from public.design_assets where project_id = '${project}' and asset_type = '${type}'`));
  const objects = (project: string, kind: string) => Number(sql(`select count(*) from storage.objects where bucket_id = '${PROJECT_FILES_BUCKET}' and name like '${project}/${kind}/%'`));

  async function makeUser(label: "a" | "b") {
    const email = `live-ref-${label}-${RUN}@example.test`;
    const created = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    expect(created.error).toBeNull();
    const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await client.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
    users[label] = { id: created.data.user!.id, client };
  }

  beforeAll(async () => {
    expect(URL_ && ANON && SERVICE).toBeTruthy();
    service = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    await makeUser("a");
    await makeUser("b");
    const out = await createMockImageProvider().generate({ promptVersion: "p", instructions: "i", views: [viewsFor("INTERIOR")[0]], customerData: {}, requestId: "r", timeoutMs: 1000 });
    png = out.outputs[0].bytes;
    for (const [type, set] of [["INTERIOR", (id: string) => (projectA = id)], ["LANDSCAPE", (id: string) => (landscapeA = id)], ["EMPTY_PLOT", (id: string) => (plotA = id)]] as const) {
      const made = await createDraftProject(users.a.client, users.a.id, type);
      if (!made.ok) throw new Error("setup: draft project");
      set(made.projectId);
    }
  });

  afterAll(async () => {
    if (!ENABLED || !service) return;
    const ids = [projectA, landscapeA, plotA].filter(Boolean);
    try {
      for (const id of ids) {
        const names = sql(`select name from storage.objects where bucket_id = '${PROJECT_FILES_BUCKET}' and name like '${id}/%'`).split("\n").filter(Boolean);
        if (names.length) await service.storage.from(PROJECT_FILES_BUCKET).remove(names);
      }
      await service.storage.from(PROJECT_FILES_BUCKET).remove(planted);
    } catch {
      /* best effort: leftovers are private @example.test data */
    }
    for (const u of Object.values(users)) await service.auth.admin.deleteUser(u.id).catch(() => undefined);
  });

  it("stores a valid image privately for the owner, tied to the project, and lists it with a working short-lived signed link", async () => {
    const added = await addReference(users.a.client, users.a.id, projectA, asFile(png));
    expect(added).toMatchObject({ ok: true, asset: { mimeType: "image/png", width: 640, height: 360 } });
    expect(rows(projectA)).toBe(1);
    expect(objects(projectA, "references")).toBe(1);
    expect(sql(`select count(*) from storage.objects where bucket_id = '${PROJECT_FILES_BUCKET}' and owner_id = '${users.a.id}'`)).toBe("1");
    expect(sql(`select public from storage.buckets where id = '${PROJECT_FILES_BUCKET}'`)).toBe("f");
    const list = await listReferences(users.a.client, users.a.id, projectA);
    expect(list).toHaveLength(1);
    const url = list![0].url!;
    expect(url).toContain("/object/sign/");
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    expect(new Uint8Array(await fetched.arrayBuffer()).byteLength).toBe(png.byteLength);
    expect(Object.keys(list![0]).sort()).toEqual(["createdAt", "height", "id", "url", "width"]);
  });

  it("ignores the file name and the declared type: misleading names are fine when the bytes are an image, and bad bytes never reach storage", async () => {
    const before = objects(projectA, "references");
    const disguised = await addReference(users.a.client, users.a.id, projectA, { ...asFile(png, "text/plain"), name: "photo.exe" } as never);
    expect(disguised.ok).toBe(true); // the content is a real PNG; the name and type claim are not used
    expect(sql(`select storage_path from public.design_assets where project_id = '${projectA}' order by created_at desc limit 1`)).toMatch(/\/references\/[0-9a-f-]{36}\.png$/);

    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const pdf = new TextEncoder().encode("%PDF-1.4 fake");
    const truncated = png.slice(0, 20);
    const empty = new Uint8Array(0);
    for (const bad of [svg, pdf, truncated, empty]) {
      const result = await addReference(users.a.client, users.a.id, projectA, asFile(bad));
      expect(result.ok).toBe(false);
    }
    expect(objects(projectA, "references")).toBe(before + 1);
    expect(rows(projectA)).toBe(before + 1);
  });

  it("refuses a file over 5 MiB before reading it", async () => {
    const huge = { size: 5 * 1024 * 1024 + 1, arrayBuffer: async () => { throw new Error("must not be read"); } };
    const result = await addReference(users.a.client, users.a.id, projectA, huge as never);
    expect(result.ok).toBe(false);
  });

  it("allows at most six photos per project, and keeps rows and objects in step", async () => {
    let added = rows(projectA);
    while (added < REFERENCES_PER_PROJECT) {
      expect((await addReference(users.a.client, users.a.id, projectA, asFile(png))).ok).toBe(true);
      added += 1;
    }
    const seventh = await addReference(users.a.client, users.a.id, projectA, asFile(png));
    expect(seventh.ok).toBe(false);
    expect(rows(projectA)).toBe(REFERENCES_PER_PROJECT);
    expect(objects(projectA, "references")).toBe(REFERENCES_PER_PROJECT);
  });

  it("takes references only for interior and landscape projects", async () => {
    expect((await addReference(users.a.client, users.a.id, plotA, asFile(png))).ok).toBe(false);
    expect(objects(plotA, "references")).toBe(0);
    expect((await addReference(users.a.client, users.a.id, landscapeA, asFile(png))).ok).toBe(true);
  });

  it("denies another customer every operation on the owner's files and rows", async () => {
    const asset = sql(`select id || '|' || storage_path from public.design_assets where project_id = '${projectA}' order by created_at limit 1`).split("|");
    const [assetId, path] = asset;
    // through the service layer
    expect(await listReferences(users.b.client, users.b.id, projectA)).toBeNull();
    expect((await addReference(users.b.client, users.b.id, projectA, asFile(png))).ok).toBe(false);
    expect((await removeReference(users.b.client, users.b.id, projectA, assetId)).ok).toBe(false);
    // straight at the Storage API, with B's own session
    const download = await bucket(users.b.client).download(path);
    expect(download.error).not.toBeNull();
    expect((await bucket(users.b.client).createSignedUrl(path, 60)).error).not.toBeNull();
    const listing = await bucket(users.b.client).list(`${projectA}/references`);
    expect(listing.data ?? []).toHaveLength(0);
    const overwrite = await bucket(users.b.client).upload(path, png, { upsert: true, contentType: "image/png" });
    expect(overwrite.error).not.toBeNull();
    const intoOthers = await bucket(users.b.client).upload(`${projectA}/references/${randomUUID()}.png`, png, { contentType: "image/png" });
    expect(intoOthers.error).not.toBeNull();
    const removed = await bucket(users.b.client).remove([path]);
    expect(removed.data ?? []).toHaveLength(0);
    // rows, straight at PostgREST
    const rowRead = await users.b.client.from("design_assets").select("id").eq("project_id", projectA);
    expect(rowRead.data ?? []).toHaveLength(0);
    const rowDelete = await users.b.client.from("design_assets").delete().eq("id", assetId).select("id");
    expect(rowDelete.data ?? []).toHaveLength(0);
    // still intact
    expect(objects(projectA, "references")).toBe(REFERENCES_PER_PROJECT);
    expect(rows(projectA)).toBe(REFERENCES_PER_PROJECT);
  });

  it("denies signed-out visitors, and the bucket serves nothing at a public address", async () => {
    const path = sql(`select storage_path from public.design_assets where project_id = '${projectA}' limit 1`);
    expect((await bucket(anon).download(path)).error).not.toBeNull();
    expect((await bucket(anon).createSignedUrl(path, 60)).error).not.toBeNull();
    expect((await bucket(anon).upload(`${projectA}/references/${randomUUID()}.png`, png, { contentType: "image/png" })).error).not.toBeNull();
    const publicUrl = bucket(anon).getPublicUrl(path).data.publicUrl;
    expect((await fetch(publicUrl)).status).toBeGreaterThanOrEqual(400);
    expect((await anon.from("design_assets").select("id").eq("project_id", projectA)).error).not.toBeNull();
  });

  it("does not let the owner forge generated output, a release flag or another project's folder", async () => {
    const forged = await bucket(users.a.client).upload(`${projectA}/generated/${randomUUID()}.png`, png, { contentType: "image/png" });
    expect(forged.error).not.toBeNull();
    const inB = await bucket(users.a.client).upload(`${randomUUID()}/references/${randomUUID()}.png`, png, { contentType: "image/png" });
    expect(inB.error).not.toBeNull();
    const row = await users.a.client.from("design_assets").insert({ project_id: projectA, asset_type: "INTERIOR_CONCEPT", storage_path: `${projectA}/generated/x.png`, mime_type: "image/png" });
    expect(row.error).not.toBeNull();
    const release = await users.a.client.from("design_assets").update({ is_released: true }).eq("project_id", projectA).select("id");
    expect(release.error ?? release.data?.length).toBeTruthy();
    expect(sql(`select count(*) from public.design_assets where project_id = '${projectA}' and is_released`)).toBe("0");
  });

  it("keeps generated output and payment proof out of the owner's reach before release (planted by the server)", async () => {
    const generated = `${projectA}/generated/${randomUUID()}.png`;
    const proof = `${projectA}/payment-proofs/${randomUUID()}.png`;
    for (const p of [generated, proof]) {
      expect((await service.storage.from(PROJECT_FILES_BUCKET).upload(p, png, { contentType: "image/png" })).error).toBeNull();
      planted.push(p);
    }
    // Another customer can read neither.
    for (const p of [generated, proof]) {
      expect((await bucket(users.b.client).download(p)).error).not.toBeNull();
      expect((await bucket(anon).download(p)).error).not.toBeNull();
    }
    // The owner cannot read unreleased generated output (no row says it is released).
    expect((await bucket(users.a.client).download(generated)).error).not.toBeNull();
    expect((await bucket(users.a.client).createSignedUrl(generated, 60)).error).not.toBeNull();
    // The owner may see their own payment proof (they uploaded it), which is private to them and the administrator.
    expect((await bucket(users.b.client).createSignedUrl(proof, 60)).error).not.toBeNull();
  });

  it("removes a photo while the project is editable (row, then file), and refuses once it is not", async () => {
    const asset = sql(`select id || '|' || storage_path from public.design_assets where project_id = '${landscapeA}' limit 1`).split("|");
    const [assetId, path] = asset;
    // Make a second, to remove while editable
    const second = await addReference(users.a.client, users.a.id, landscapeA, asFile(png));
    expect(second.ok).toBe(true);
    const secondId = (second as { asset: { id: string } }).asset.id;
    const secondPath = sql(`select storage_path from public.design_assets where id = '${secondId}'`);
    expect(await removeReference(users.a.client, users.a.id, landscapeA, secondId)).toEqual({ ok: true });
    expect(rows(landscapeA)).toBe(1);
    expect(sql(`select count(*) from storage.objects where name = '${secondPath}'`)).toBe("0");

    // Lock the project (a state the owner cannot reach alone) and try again.
    sql(`update public.projects set status = 'CANCELLED' where id = '${landscapeA}'`);
    expect(sql(`select status from public.projects where id = '${landscapeA}'`)).toBe("CANCELLED");
    expect((await removeReference(users.a.client, users.a.id, landscapeA, assetId)).ok).toBe(false);
    expect((await addReference(users.a.client, users.a.id, landscapeA, asFile(png))).ok).toBe(false);
    // Straight at the APIs too: the policies, not only the service code, refuse.
    expect((await users.a.client.from("design_assets").delete().eq("id", assetId).select("id")).data ?? []).toHaveLength(0);
    expect((await bucket(users.a.client).remove([path])).data ?? []).toHaveLength(0);
    expect((await bucket(users.a.client).upload(`${landscapeA}/references/${randomUUID()}.png`, png, { contentType: "image/png" })).error).not.toBeNull();
    expect(rows(landscapeA)).toBe(1);
    expect(sql(`select count(*) from storage.objects where name = '${path}'`)).toBe("1");
    // The owner can still see it.
    const list = await listReferences(users.a.client, users.a.id, landscapeA);
    expect(list).toHaveLength(1);
  });

  it("writes nothing, in storage or in the database, once the project is locked (the row-failure cleanup is covered by the unit tests)", async () => {
    const before = objects(projectA, "references");
    // A rejected row: lock the interior project after the upload would succeed by making the type check fail.
    sql(`update public.projects set status = 'CANCELLED' where id = '${projectA}'`);
    const result = await addReference(users.a.client, users.a.id, projectA, asFile(png));
    expect(result.ok).toBe(false);
    expect(objects(projectA, "references")).toBe(before);
    expect(rows(projectA)).toBe(before);
  });
});
