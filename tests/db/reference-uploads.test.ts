import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, anon, as, createAdmin, createDatabase, createUser, expectError, user } from "./support/harness";

const BUCKET = "project-files";

/**
 * Reference photos against REAL PostgreSQL logic (PGlite): the two writes the application makes
 * for an upload (a storage object, then a design_assets row) and its removal, run as the
 * customer's database role, so row level security and the table guards decide. These prove the
 * policies; the stand-in storage tables do not prove Supabase's Storage service itself.
 */
describe("reference uploads: row level security and guards", () => {
  let db: PGlite;
  let a: string;
  let b: string;
  let admin: string;

  beforeAll(async () => {
    db = await createDatabase();
    a = await createUser(db, "customer-a");
    b = await createUser(db, "customer-b");
    admin = await createAdmin(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const putObject = (actor: Parameters<typeof as>[1], name: string) =>
    as(db, actor, (q) => q("insert into storage.objects (bucket_id, name) values ($1, $2) returning id", [BUCKET, name]));
  /** Exactly the columns the application inserts: the ones customers are granted (see the rls migration). */
  const putRow = (actor: Parameters<typeof as>[1], projectId: string, path: string, extra: { type?: string } = {}) =>
    as(db, actor, (q) =>
      q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type, width, height) values ($1, $2, $3, 'image/png', 640, 360) returning id", [projectId, extra.type ?? "REFERENCE", path]),
    );
  const rowsVisibleTo = (actor: Parameters<typeof as>[1], projectId: string) =>
    as(db, actor, (q) => q<{ id: string }>("select id from public.design_assets where project_id = $1", [projectId])).then((r) => r.length);
  const objectsVisibleTo = (actor: Parameters<typeof as>[1], projectId: string) =>
    as(db, actor, (q) => q<{ name: string }>("select name from storage.objects where name like $1", [`${projectId}/%`])).then((r) => r.length);

  it("lets the owner add a photo (object, then row) while the project is editable, and keeps it unreleased", async () => {
    const s = await Scenario.create(db, a, admin);
    const path = `${s.projectId}/references/11111111-1111-4111-8111-111111111111.png`;
    await putObject(user(a), path);
    const [{ id }] = await putRow(user(a), s.projectId, path);
    expect(id).toBeTruthy();
    const stored = await as(db, user(a), (q) => q<{ is_released: boolean; generation_job_id: string | null }>("select is_released, generation_job_id from public.design_assets where id = $1", [id]));
    expect(stored[0]).toEqual({ is_released: false, generation_job_id: null });
  });

  it("refuses another customer on both writes, for a project that is not theirs", async () => {
    const s = await Scenario.create(db, a, admin);
    const path = `${s.projectId}/references/22222222-2222-4222-8222-222222222222.png`;
    await expectError(putObject(user(b), path), /row-level security/);
    await expectError(putRow(user(b), s.projectId, path), /row-level security|your own projects|project not found/);
    expect(await rowsVisibleTo(user(a), s.projectId)).toBe(0);
  });

  it("refuses signed-out visitors", async () => {
    const s = await Scenario.create(db, a, admin);
    const path = `${s.projectId}/references/33333333-3333-4333-8333-333333333333.png`;
    await expectError(putObject(anon, path), /row-level security|permission denied/);
    await expectError(putRow(anon, s.projectId, path), /permission denied|row-level security/);
  });

  it("locks both the upload and the removal once the brief is approved", async () => {
    const s = await Scenario.create(db, a, admin);
    const path = `${s.projectId}/references/44444444-4444-4444-8444-444444444444.png`;
    await putObject(user(a), path);
    await putRow(user(a), s.projectId, path);
    await s.toBriefApproved();
    const late = `${s.projectId}/references/55555555-5555-4555-8555-555555555555.png`;
    await expectError(putObject(user(a), late), /row-level security/);
    await expectError(putRow(user(a), s.projectId, late), /row-level security|only while the project is editable/);
    // removal is refused too: the delete matches no row
    const gone = await as(db, user(a), (q) => q("delete from public.design_assets where project_id = $1 returning id", [s.projectId]));
    expect(gone).toHaveLength(0);
    const objGone = await as(db, user(a), (q) => q("delete from storage.objects where name = $1 returning id", [path]));
    expect(objGone).toHaveLength(0);
    expect(await rowsVisibleTo(user(a), s.projectId)).toBe(1);
  });

  it("lets a customer add only REFERENCE or PAYMENT_PROOF rows: never a generated deliverable; the release flag and job link are not writable", async () => {
    const s = await Scenario.create(db, a, admin);
    const path = `${s.projectId}/generated/66666666-6666-4666-8666-666666666666.png`;
    await expectError(putRow(user(a), s.projectId, path, { type: "EXTERIOR_CONCEPT" }), /row-level security|only reference files and payment proof|generated assets|violates/);
    // The release flag and the job link are not columns a customer may write at all.
    const ref = `${s.projectId}/references/77777777-7777-4777-8777-777777777777.png`;
    await expectError(as(db, user(a), (q) => q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type, is_released) values ($1, 'REFERENCE', $2, 'image/png', true)", [s.projectId, ref])), /permission denied/);
    await expectError(as(db, user(a), (q) => q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type, generation_job_id) values ($1, 'REFERENCE', $2, 'image/png', gen_random_uuid())", [s.projectId, ref])), /permission denied/);
    expect(await rowsVisibleTo(user(a), s.projectId)).toBe(0);
  });

  it("ties every row to its project's own folder and kind by a table constraint", async () => {
    const s = await Scenario.create(db, a, admin);
    const t = await Scenario.create(db, a, admin);
    await putObject(user(a), `${s.projectId}/references/99999999-9999-4999-8999-999999999999.png`);
    await expectError(putRow(user(a), s.projectId, `${t.projectId}/references/99999999-9999-4999-8999-999999999999.png`), /design_assets_path_matches_type|violates/);
    await expectError(putRow(user(a), s.projectId, `${s.projectId}/payment-proofs/x.png`), /design_assets_path_matches_type|violates/);
  });

  it("keeps each customer's photos invisible to everyone else, and visible to an administrator for review", async () => {
    const s = await Scenario.create(db, a, admin);
    const path = `${s.projectId}/references/aaaaaaaa-0000-4000-8000-000000000001.png`;
    await putObject(user(a), path);
    await putRow(user(a), s.projectId, path);
    expect(await rowsVisibleTo(user(a), s.projectId)).toBe(1);
    expect(await objectsVisibleTo(user(a), s.projectId)).toBe(1);
    expect(await rowsVisibleTo(user(b), s.projectId)).toBe(0);
    expect(await objectsVisibleTo(user(b), s.projectId)).toBe(0);
    // a signed-out visitor has no privilege on the table at all, and sees no stored file
    await expectError(rowsVisibleTo(anon, s.projectId), /permission denied/);
    expect(await objectsVisibleTo(anon, s.projectId)).toBe(0);
    expect(await rowsVisibleTo(user(admin), s.projectId)).toBe(1);
    expect(await objectsVisibleTo(user(admin), s.projectId)).toBe(1);
  });

  it("lets the owner remove their own photo (row and object) while editable, and nobody else", async () => {
    const s = await Scenario.create(db, a, admin);
    const path = `${s.projectId}/references/aaaaaaaa-0000-4000-8000-000000000002.png`;
    await putObject(user(a), path);
    await putRow(user(a), s.projectId, path);
    expect(await as(db, user(b), (q) => q("delete from public.design_assets where project_id = $1 returning id", [s.projectId]))).toHaveLength(0);
    expect(await as(db, user(b), (q) => q("delete from storage.objects where name = $1 returning id", [path]))).toHaveLength(0);
    expect(await as(db, user(a), (q) => q("delete from public.design_assets where project_id = $1 returning id", [s.projectId]))).toHaveLength(1);
    expect(await as(db, user(a), (q) => q("delete from storage.objects where name = $1 returning id", [path]))).toHaveLength(1);
  });

  it("rejects two rows for the same stored file", async () => {
    const s = await Scenario.create(db, a, admin);
    const path = `${s.projectId}/references/aaaaaaaa-0000-4000-8000-000000000003.png`;
    await putObject(user(a), path);
    await putRow(user(a), s.projectId, path);
    await expectError(putRow(user(a), s.projectId, path), /duplicate key|unique/);
  });

  it("does not let a customer upload into the generated folder or change a released flag", async () => {
    const s = await Scenario.create(db, a, admin);
    await expectError(putObject(user(a), `${s.projectId}/generated/forged.png`), /row-level security/);
    const path = `${s.projectId}/references/aaaaaaaa-0000-4000-8000-000000000004.png`;
    await putObject(user(a), path);
    await putRow(user(a), s.projectId, path);
    await expectError(as(db, user(a), (q) => q("update public.design_assets set is_released = true where project_id = $1", [s.projectId])), /permission denied|released|row-level security/);
  });
});
