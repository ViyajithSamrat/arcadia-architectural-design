import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, as, createAdmin, createUser, expectError, service, user } from "./support/harness";

/**
 * On a real Supabase project the migrations run as `postgres`, which is NOT a
 * superuser: it has CREATEROLE and BYPASSRLS, owns `public`, and is only a member
 * of the roles that own the auth and storage objects. This applies the migrations
 * the same way (as a non-superuser owner) and repeats the key security checks, so
 * the result does not depend on superuser powers the real migration role lacks.
 */
const ROOT = process.cwd();

describe("migrations applied by a non-superuser owner (Supabase-like)", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    const shim = readFileSync(path.join(ROOT, "tests/db/support/supabase-shim.sql"), "utf8");
    await db.exec(shim);
    await db.exec(`
      create role supabase_storage_admin nologin;
      create role app_owner nologin createrole bypassrls;
      grant supabase_storage_admin to app_owner;
      grant create on database postgres to app_owner;
      alter table storage.buckets owner to supabase_storage_admin;
      alter table storage.objects owner to supabase_storage_admin;
      alter schema public owner to app_owner;
      grant usage on schema auth, storage to app_owner;
      grant references, select on auth.users to app_owner;
      alter default privileges for role app_owner in schema public grant all on tables    to anon, authenticated, service_role;
      alter default privileges for role app_owner in schema public grant all on functions to anon, authenticated, service_role;
      alter default privileges for role app_owner in schema public grant all on sequences to anon, authenticated, service_role;
    `);
    await db.exec("set role app_owner");
    const dir = path.join(ROOT, "supabase/migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(path.join(dir, file), "utf8"));
    }
    await db.exec("reset role");
  });

  afterAll(async () => {
    await db.close();
  });

  it("applies cleanly and the workflow completes to release", async () => {
    const customer = await createUser(db, "c");
    const admin = await createAdmin(db);
    const s = await Scenario.create(db, customer, admin);
    await s.toBriefApproved();
    await s.toQuoted();
    await s.toAwaitingPayment();
    await s.submitPayment();
    await s.verify();
    expect(await s.status()).toBe("PAYMENT_VERIFIED");
  });

  it("still blocks the critical bypasses", async () => {
    const a = await createUser(db, "a");
    const b = await createUser(db, "b");
    const admin = await createAdmin(db, "adm");
    const s = await Scenario.create(db, a, admin);
    await expectError(s.setStatus(user(a), "GENERATING"), /trusted server code|permission denied/i);
    await expectError(
      as(db, user(b), (q) => q("select * from public.admin_release_project($1)", [s.projectId])),
      /admin|not allowed|forbidden|not found/i,
    );
    await s.toBriefApproved();
    await s.toQuoted();
    await s.toAwaitingPayment();
    await s.setStatus(service, "PAYMENT_PROOF_SUBMITTED").catch(() => undefined);
    await expectError(
      as(db, service, (q) =>
        q("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'mock', 'v1')", [s.projectId]),
      ),
      /.+/,
    );
  });

  it("the service role has no admin identity, so it cannot verify, reject or release", async () => {
    const customer = await createUser(db, "svc");
    const admin = await createAdmin(db, "adm3");
    const s = await Scenario.create(db, customer, admin);
    await s.toBriefApproved();
    await s.toQuoted();
    await s.toAwaitingPayment();
    await s.submitPayment();
    await expectError(
      as(db, service, (q) => q("select * from public.admin_verify_payment($1, '1000.00', 'x')", [s.paymentId])),
      /.+/,
    );
    await expectError(as(db, service, (q) => q("select * from public.admin_release_project($1)", [s.projectId])), /.+/);
    expect(await s.status()).toBe("PAYMENT_PROOF_SUBMITTED");
  });

  it("a customer cannot unlock anything by setting the internal app.via flag", async () => {
    const a = await createUser(db, "spoof");
    const admin = await createAdmin(db, "adm2");
    const s = await Scenario.create(db, a, admin);
    for (const via of ["payment_cascade", "admin_release", "release_cascade"]) {
      await expectError(
        as(db, user(a), async (q) => {
          await q("select set_config('app.via', $1, true)", [via]);
          await q("update public.projects set status = 'RELEASED' where id = $1", [s.projectId]);
        }),
        /.+/,
      );
    }
    expect(await s.status()).toBe("DRAFT");
  });
});
