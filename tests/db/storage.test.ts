import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, anon, as, createAdmin, createDatabase, createUser, expectError, service, superuser, user } from "./support/harness";

const BUCKET = "project-files";

/**
 * Private file access. Object names are  <project_id>/<kind>/<file>.
 * (Stand-in storage tables: these tests prove the policy logic, not Supabase's
 * Storage service itself.)
 */
describe("private storage policies", () => {
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

  const put = (actor: Parameters<typeof as>[1], name: string, bucket = BUCKET) =>
    as(db, actor, (q) => q("insert into storage.objects (bucket_id, name) values ($1, $2) returning id", [bucket, name]));
  const names = (actor: Parameters<typeof as>[1]) =>
    as(db, actor, (q) => q<{ name: string }>("select name from storage.objects order by name")).then((rows) => rows.map((r) => r.name));

  it("is a private bucket: no public access", async () => {
    const rows = await as(db, superuser, (q) => q<{ public: boolean }>("select public from storage.buckets where id = $1", [BUCKET]));
    expect(rows[0].public).toBe(false);
  });

  it("lets a customer upload references to their own editable project only", async () => {
    const mine = await Scenario.create(db, a, admin);
    const theirs = await Scenario.create(db, b, admin);
    await put(user(a), `${mine.projectId}/references/room.jpg`);
    await expectError(put(user(a), `${theirs.projectId}/references/room.jpg`), /row-level security/);
  });

  it("refuses malformed paths, other buckets and the generated folder", async () => {
    const s = await Scenario.create(db, a, admin);
    await expectError(put(user(a), `${s.projectId}/references`), /row-level security/); // too few segments
    await expectError(put(user(a), `${s.projectId}/references/deep/er.jpg`), /row-level security/); // too many segments
    await expectError(put(user(a), `not-a-project/references/x.jpg`), /row-level security/);
    await expectError(put(user(a), `${s.projectId}/mystery/x.jpg`), /row-level security/);
    await expectError(put(user(a), `${s.projectId}/generated/forged.png`), /row-level security/);
    await as(db, superuser, (q) => q("insert into storage.buckets (id, name, public) values ('other-bucket', 'other-bucket', false)"));
    await expectError(put(user(a), `${s.projectId}/references/x.jpg`, "other-bucket"), /row-level security/);
  });

  it("accepts payment proof only while the project awaits payment", async () => {
    const s = await Scenario.create(db, a, admin);
    await expectError(put(user(a), `${s.projectId}/payment-proofs/early.png`), /row-level security/);
    await s.toBriefApproved();
    await s.toQuoted();
    await s.toAwaitingPayment();
    await put(user(a), `${s.projectId}/payment-proofs/proof.png`);
    // References are locked once the brief is approved.
    await expectError(put(user(a), `${s.projectId}/references/late.jpg`), /row-level security/);
  });

  it("shows each customer only their own files", async () => {
    const sa = await Scenario.create(db, a, admin);
    const sb = await Scenario.create(db, b, admin);
    await put(user(a), `${sa.projectId}/references/a-only.jpg`);
    await put(user(b), `${sb.projectId}/references/b-only.jpg`);
    const seenByA = await names(user(a));
    const seenByB = await names(user(b));
    expect(seenByA).toContain(`${sa.projectId}/references/a-only.jpg`);
    expect(seenByA).not.toContain(`${sb.projectId}/references/b-only.jpg`);
    expect(seenByB).toContain(`${sb.projectId}/references/b-only.jpg`);
    expect(seenByB).not.toContain(`${sa.projectId}/references/a-only.jpg`);
  });

  it("lets signed-out visitors see no file at all", async () => {
    expect(await names(anon)).toEqual([]);
    await expectError(put(anon, `00000000-0000-4000-8000-000000000000/references/x.jpg`), /row-level security|permission denied/);
  });

  it("hides generated files from their own owner until the administrator releases them", async () => {
    const s = await Scenario.advance(db, a, admin, "ready");
    const generated = `${s.projectId}/generated/plan.svg`;
    // Trusted server code stores the generated file.
    await put(service, generated);

    expect(await names(user(a))).not.toContain(generated); // not yet released
    expect(await names(user(b))).not.toContain(generated); // never visible to others
    expect(await names(anon)).not.toContain(generated);
    expect(await names(user(admin))).toContain(generated); // administrator may preview

    await s.release();
    expect(await names(user(a))).toContain(generated); // owner, after release
    expect(await names(user(b))).not.toContain(generated); // still not other customers
    expect(await names(anon)).not.toContain(generated);
  });

  it("never lets a customer write or replace generated files, even after release", async () => {
    const s = await Scenario.advance(db, a, admin, "released");
    await expectError(put(user(a), `${s.projectId}/generated/other.svg`), /row-level security/);
    const updated = await as(db, user(a), (q) =>
      q("update storage.objects set name = $2 where name = $1 returning id", [`${s.projectId}/generated/plan.svg`, `${s.projectId}/generated/renamed.svg`]),
    );
    expect(updated).toEqual([]);
  });

  it("lets a customer delete their draft reference but never payment proof or generated files", async () => {
    const s = await Scenario.create(db, a, admin);
    const ref = `${s.projectId}/references/delete-me.jpg`;
    await put(user(a), ref);
    const removed = await as(db, user(a), (q) => q("delete from storage.objects where name = $1 returning id", [ref]));
    expect(removed).toHaveLength(1);

    await s.toBriefApproved();
    await s.toQuoted();
    await s.toAwaitingPayment();
    const proof = `${s.projectId}/payment-proofs/keep.png`;
    await put(user(a), proof);
    expect(await as(db, user(a), (q) => q("delete from storage.objects where name = $1 returning id", [proof]))).toEqual([]);
    await put(service, `${s.projectId}/generated/keep.svg`);
    expect(await as(db, user(a), (q) => q("delete from storage.objects where name like '%/generated/%' returning id"))).toEqual([]);
  });

  it("does not let another customer delete someone else's files", async () => {
    const s = await Scenario.create(db, a, admin);
    const ref = `${s.projectId}/references/protected.jpg`;
    await put(user(a), ref);
    expect(await as(db, user(b), (q) => q("delete from storage.objects where name = $1 returning id", [ref]))).toEqual([]);
    expect(await names(user(a))).toContain(ref);
  });

  it("lets the administrator read payment proof for review, but not change files", async () => {
    const s = await Scenario.advance(db, a, admin, "draft");
    await s.toBriefApproved();
    await s.toQuoted();
    await s.toAwaitingPayment();
    const proof = `${s.projectId}/payment-proofs/for-admin.png`;
    await put(user(a), proof);
    expect(await names(user(admin))).toContain(proof);
    await expectError(put(user(admin), `${s.projectId}/generated/admin-write.svg`), /row-level security/);
  });
});
