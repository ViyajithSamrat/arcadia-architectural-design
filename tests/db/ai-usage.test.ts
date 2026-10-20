import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GNANI_HARD_CEILING_CREDITS } from "@/lib/providers/config";
import { anon, as, createAdmin, createDatabase, createUser, expectError, service, superuser, user } from "./support/harness";

/**
 * The AI usage ledger and budget guard (migration 7). In-process Postgres only: these
 * prove the SQL logic, not Supabase's API layer, real concurrency or PostgREST error codes
 * (those need the local stack; see handoff.md).
 */
describe("ai_usage budget guard", () => {
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

  type Opts = {
    customerLimit?: number | string | null;
    globalLimit?: number | string | null;
    globalWindow?: number | null;
    provider?: string;
    operation?: string;
    unit?: string;
    inFlight?: number | null;
  };
  // Default: Gnani speech-to-text, customer limit 3 per 60 minutes, provider ceiling 10 for ever, in credits.
  const reserve = (customer: string, units: number | string, opts: Opts = {}) => {
    const provider = opts.provider ?? "gnani";
    const operation = opts.operation ?? (provider === "gnani" ? "stt" : "brief");
    const unit = opts.unit ?? (provider === "gnani" ? "credit" : "request");
    return as(db, service, (q) =>
      q<{ id: string }>("select public.ai_usage_reserve($1, null, $2, $3, 'm', $4, $5::numeric, $6::numeric, 60, $7::numeric, $8, $9) as id", [
        customer,
        provider,
        operation,
        unit,
        units,
        opts.customerLimit === undefined ? 3 : opts.customerLimit,
        opts.globalLimit === undefined ? 10 : opts.globalLimit,
        opts.globalWindow === undefined ? null : opts.globalWindow,
        opts.inFlight === undefined ? null : opts.inFlight,
      ]),
    );
  };
  const finish = (id: string, status: string, reported: number | null = null) =>
    as(db, service, (q) => q("select public.ai_usage_finish($1, $2, $3, 'req-1')", [id, status, reported]));
  const reset = () => as(db, superuser, (q) => q("alter table public.ai_usage disable trigger trg_10_ai_usage_guard").then(() => q("delete from public.ai_usage")).then(() => q("alter table public.ai_usage enable trigger trg_10_ai_usage_guard")));
  const count = async () => Number((await as(db, superuser, (q) => q<{ n: string }>("select count(*)::text as n from public.ai_usage")))[0].n);
  const ageEverything = (interval: string) =>
    as(db, superuser, async (q) => {
      await q("alter table public.ai_usage disable trigger trg_10_ai_usage_guard");
      await q(`update public.ai_usage set created_at = now() - interval '${interval}'`);
      await q("alter table public.ai_usage enable trigger trg_10_ai_usage_guard");
    });

  it("reserves within the limits and records a RESERVED row", async () => {
    await reset();
    const [{ id }] = await reserve(a, 2);
    const rows = await as(db, superuser, (q) => q<{ status: string; units_estimated: string; unit: string }>("select status, units_estimated::text, unit from public.ai_usage where id = $1", [id]));
    expect(rows[0]).toEqual({ status: "RESERVED", units_estimated: "2.00", unit: "credit" });
  });

  it("refuses a customer over their own limit (AI001) and records nothing", async () => {
    await reset();
    await reserve(a, 2);
    await expectError(reserve(a, 2), /customer usage limit reached/);
    expect(await count()).toBe(1);
    await reserve(b, 3); // another customer is unaffected
  });

  it("shares one customer limit across a provider's operations (speech-to-text plus text-to-speech)", async () => {
    await reset();
    await reserve(a, 2, { operation: "stt" });
    await expectError(reserve(a, 2, { operation: "tts" }), /customer usage limit reached/);
    await reserve(a, 1, { operation: "tts" });
  });

  it("refuses everyone once the provider ceiling is reached (AI002), cumulatively", async () => {
    await reset();
    const customers = [a, b, await createUser(db, "c"), await createUser(db, "d")];
    await reserve(customers[0], 3);
    await reserve(customers[1], 3);
    await reserve(customers[2], 3);
    await expectError(reserve(customers[3], 2), /provider usage ceiling reached/);
    await reserve(customers[3], 1); // exactly the ceiling is allowed
    await expectError(reserve(customers[3], 1), /(provider usage ceiling|customer usage limit) reached/);
  });

  it("counts a call as the larger of its estimate and its reported usage, and never refunds", async () => {
    await reset();
    const [{ id: failed }] = await reserve(a, 3);
    await finish(failed, "FAILED");
    await expectError(reserve(a, 1), /customer usage limit reached/); // failed call still counts
    await reset();
    const [{ id: cheap }] = await reserve(a, 3);
    await finish(cheap, "SUCCEEDED", 1); // the provider reported less than estimated: still 3
    await expectError(reserve(a, 1), /customer usage limit reached/);
    await reset();
    const [{ id: zero }] = await reserve(a, 3);
    await finish(zero, "FAILED", 0); // reported 0 must not refund
    await expectError(reserve(a, 1), /customer usage limit reached/);
    await reset();
    const [{ id: dear }] = await reserve(a, 1);
    await finish(dear, "SUCCEEDED", 3); // reported more than estimated: the larger counts
    await expectError(reserve(a, 1), /customer usage limit reached/);
  });

  it("releases a call that was never sent", async () => {
    await reset();
    const [{ id: unsent }] = await reserve(a, 3);
    await finish(unsent, "NOT_SENT");
    await reserve(a, 3);
  });

  it("a daily window forgets old calls; a cumulative ceiling does not", async () => {
    await reset();
    await reserve(a, 3);
    await ageEverything("2 days");
    await reserve(a, 3); // old call is outside the 60-minute customer window
    await reset();
    await as(db, superuser, (q) => q("insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated, status, created_at) values ($1, 'openrouter', 'brief', 'request', 10, 'SUCCEEDED', now() - interval '3 days')", [a]));
    await expectError(reserve(b, 1, { provider: "openrouter" }), /provider usage ceiling reached/); // cumulative: old spend still counts
    await reserve(b, 1, { provider: "openrouter", globalWindow: 60 * 24 }); // a 24-hour window ignores it
  });

  it("does not mix units or providers", async () => {
    await reset();
    await reserve(a, 3);
    await reserve(a, 3, { provider: "openrouter" });
  });

  it("fails closed when any limit is missing or invalid, reserving nothing", async () => {
    await reset();
    await expectError(reserve(a, 1, { customerLimit: null }), /missing or invalid/);
    await expectError(reserve(a, 1, { globalLimit: null }), /missing or invalid/);
    await expectError(reserve(a, 1, { customerLimit: 0 }), /missing or invalid/);
    await expectError(reserve(a, 1, { globalLimit: -5 }), /missing or invalid/);
    await expectError(reserve(a, -1), /missing or invalid/);
    await expectError(reserve(a, 0), /missing or invalid/);
    await expectError(reserve(a, 1, { inFlight: 0 }), /missing or invalid/);
    expect(await count()).toBe(0);
  });

  it("refuses NaN and Infinity for every numeric parameter, reserving nothing", async () => {
    await reset();
    for (const bad of ["NaN", "Infinity", "-Infinity"]) {
      await expectError(reserve(a, bad), /missing or invalid/);
      await expectError(reserve(a, 1, { customerLimit: bad }), /missing or invalid/);
      await expectError(reserve(a, 1, { globalLimit: bad }), /missing or invalid/);
    }
    await expectError(reserve(a, "1e10"), /missing or invalid/); // beyond the column
    expect(await count()).toBe(0);
    await expectError(finish((await reserve(a, 1))[0].id, "SUCCEEDED", Number.NaN), /invalid reported usage/);
  });

  it("rounds a fractional amount UP to two decimals, so it is never recorded as zero", async () => {
    await reset();
    const [{ id }] = await reserve(a, "0.004");
    const rows = await as(db, superuser, (q) => q<{ u: string }>("select units_estimated::text as u from public.ai_usage where id = $1", [id]));
    expect(rows[0].u).toBe("0.01");
    await reset();
    await reserve(a, "1.001", { customerLimit: 1.005 }).then(
      () => {
        throw new Error("1.001 is stored as 1.01, which is over 1.005");
      },
      (e: Error) => expect(e.message).toMatch(/customer usage limit reached/),
    );
  });

  it("only accepts the known provider, operation and unit combinations", async () => {
    await reset();
    await expectError(reserve(a, 1, { unit: "request" }), /unknown provider, operation or unit/); // gnani measured in requests
    await expectError(reserve(a, 1, { provider: "openrouter", unit: "credit" }), /unknown provider, operation or unit/);
    await expectError(reserve(a, 1, { operation: "brief" }), /unknown provider, operation or unit/);
    await expectError(reserve(a, 1, { provider: "openrouter", operation: "stt" }), /unknown provider, operation or unit/);
    await expectError(reserve(a, 1, { provider: "other" }), /unknown provider, operation or unit/);
    await expectError(
      as(db, superuser, (q) => q("insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated) values ($1, 'gnani', 'stt', 'request', 1)", [a])),
      /ai_usage_provider_shape/,
    );
    expect(await count()).toBe(0);
  });

  it("clamps the Gnani ceiling to 5,000 credits in SQL, whatever the caller passes", async () => {
    await reset();
    await reserve(a, 3000, { customerLimit: 1000000, globalLimit: 1000000 });
    await expectError(reserve(b, 3000, { customerLimit: 1000000, globalLimit: 1000000 }), /provider usage ceiling reached/);
    await reserve(b, 2000, { customerLimit: 1000000, globalLimit: 1000000 }); // exactly 5,000 is allowed
    await expectError(reserve(b, 0.01, { customerLimit: 1000000, globalLimit: 1000000 }), /provider usage ceiling reached/);
  });

  it("keeps the SQL ceiling equal to the application constant", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/20261018000200_ai_usage.sql"), "utf8");
    const match = /c_gnani_ceiling constant numeric := (\d+);/.exec(sql);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(GNANI_HARD_CEILING_CREDITS);
  });

  it("refuses a time window for Gnani, since an old call could fall out of it", async () => {
    await reset();
    await expectError(reserve(a, 1, { globalWindow: 60 * 24 }), /cumulative and cannot use a window/);
    expect(await count()).toBe(0);
  });

  it("allows only the given number of calls in flight (AI003), and frees the slot when a call finishes", async () => {
    await reset();
    const [{ id }] = await reserve(a, 1, { inFlight: 1 });
    await expectError(reserve(b, 1, { inFlight: 1 }), /too many calls in flight/);
    await reserve(b, 1); // no cap given: allowed
    await finish(id, "SUCCEEDED", 1);
    const later = await createUser(db, "later");
    await expectError(reserve(later, 1, { inFlight: 1 }), /too many calls in flight/); // b's call is still reserved
    const rows = await as(db, superuser, (q) => q<{ id: string }>("select id from public.ai_usage where status = 'RESERVED'"));
    await finish(rows[0].id, "SUCCEEDED", 1);
    await reserve(later, 1, { inFlight: 1 });
  });

  it("ignores a reservation older than two minutes when counting calls in flight, but still counts its spend", async () => {
    await reset();
    await reserve(a, 3, { globalLimit: 4 });
    await ageEverything("5 minutes");
    await reserve(b, 1, { inFlight: 1, globalLimit: 4 }); // abandoned slot is not blocking
    await expectError(reserve(await createUser(db, "z"), 1, { inFlight: 5, globalLimit: 4 }), /provider usage ceiling reached/);
  });

  it("refuses to run outside READ COMMITTED, where the snapshot could predate the lock", async () => {
    await reset();
    await db.exec("begin isolation level repeatable read");
    try {
      await db.exec("set local role service_role");
      await expectError(
        db.query("select public.ai_usage_reserve($1, null, 'gnani', 'stt', 'm', 'credit', 1, 3, 60, 10, null, null)", [a]),
        /requires READ COMMITTED/,
      );
    } finally {
      await db.exec("rollback");
    }
    expect(await count()).toBe(0);
  });

  it("finishes a reservation once only", async () => {
    await reset();
    const [{ id }] = await reserve(a, 1);
    await finish(id, "SUCCEEDED", 1);
    await expectError(finish(id, "FAILED"), /not found or already finished/);
    await expectError(as(db, service, (q) => q("select public.ai_usage_finish($1, 'RESERVED')", [id])), /invalid final status/);
  });

  it("refuses a NULL or unknown final status", async () => {
    await reset();
    const [{ id }] = await reserve(a, 1);
    await expectError(as(db, service, (q) => q("select public.ai_usage_finish($1, null)", [id])), /invalid final status/);
    await expectError(as(db, service, (q) => q("select public.ai_usage_finish($1, 'DONE')", [id])), /invalid final status/);
    await finish(id, "SUCCEEDED", 1); // still finishable afterwards
  });

  it("a reservation carries no outcome until it is finished", async () => {
    await reset();
    await expectError(
      as(db, superuser, (q) => q("insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated, request_id) values ($1, 'gnani', 'stt', 'credit', 1, 'x')", [a])),
      /ai_usage_outcome_shape/,
    );
    await expectError(
      as(db, superuser, (q) => q("insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated, units_reported) values ($1, 'gnani', 'stt', 'credit', 1, 1)", [a])),
      /ai_usage_outcome_shape/,
    );
  });

  it("rejects a zero or NaN estimate in the table itself", async () => {
    await reset();
    for (const bad of ["0", "'NaN'"]) {
      await expectError(
        as(db, superuser, (q) => q(`insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated) values ($1, 'gnani', 'stt', 'credit', ${bad})`, [a])),
        /units_estimated|check constraint/,
      );
    }
  });

  it("only trusted server code can call the functions or write the ledger", async () => {
    await reset();
    for (const actor of [anon, user(a), user(admin)]) {
      await expectError(as(db, actor, (q) => q("select public.ai_usage_reserve($1, null, 'gnani', 'stt', 'm', 'credit', 1, 3, 60, 10, null, null)", [a])), /permission denied/);
      await expectError(as(db, actor, (q) => q("select public.ai_usage_finish($1, 'FAILED')", [a])), /permission denied/);
      await expectError(as(db, actor, (q) => q("insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated) values ($1, 'gnani', 'stt', 'credit', 1)", [a])), /permission denied|row-level security/);
    }
  });

  it("customers cannot read the ledger, an administrator reads all, anonymous nothing", async () => {
    await reset();
    await reserve(a, 1);
    await reserve(b, 1);
    const own = (id: string) => as(db, user(id), (q) => q<{ customer_id: string }>("select customer_id from public.ai_usage"));
    expect(await own(a)).toEqual([]);
    expect(await own(b)).toEqual([]);
    expect(await as(db, user(admin), (q) => q("select id from public.ai_usage"))).toHaveLength(2);
    await expectError(as(db, anon, (q) => q("select id from public.ai_usage")), /permission denied/);
  });

  it("customers cannot change or delete usage rows, and nobody can delete or truncate them", async () => {
    await reset();
    const [{ id }] = await reserve(a, 1);
    await expectError(as(db, user(a), (q) => q("update public.ai_usage set units_estimated = 1 where id = $1", [id])), /permission denied/);
    await expectError(as(db, user(a), (q) => q("delete from public.ai_usage where id = $1", [id])), /permission denied/);
    await expectError(as(db, service, (q) => q("delete from public.ai_usage where id = $1", [id])), /permission denied/);
    await expectError(as(db, service, (q) => q("truncate public.ai_usage")), /permission denied/);
    await expectError(as(db, superuser, (q) => q("delete from public.ai_usage where id = $1", [id])), /cannot be deleted or truncated/);
    await expectError(as(db, superuser, (q) => q("truncate public.ai_usage")), /cannot be deleted or truncated/);
    expect(await count()).toBe(1);
  });

  it("gives the service role select, insert and update on the ledger and nothing more", async () => {
    const rows = await as(db, superuser, (q) =>
      q<{ privilege_type: string }>(
        "select privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'ai_usage' and grantee = 'service_role' order by privilege_type",
      ),
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("a reservation's estimate and owner are immutable, even for trusted code", async () => {
    await reset();
    const [{ id }] = await reserve(a, 2);
    await expectError(as(db, service, (q) => q("update public.ai_usage set units_estimated = 1 where id = $1", [id])), /immutable/);
    await expectError(as(db, service, (q) => q("update public.ai_usage set customer_id = $2 where id = $1", [id, b])), /immutable/);
  });

  it("serializes reservations: a burst can never exceed the ceiling", async () => {
    await reset();
    const customers = await Promise.all(Array.from({ length: 6 }, (_, i) => createUser(db, `burst-${i}`)));
    const results = await Promise.allSettled(customers.map((c) => reserve(c, 3, { customerLimit: 5, globalLimit: 10 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3); // 3 x 3 = 9 <= 10, a fourth would be 12
    const total = await as(db, superuser, (q) => q<{ s: string }>("select sum(units_estimated)::text as s from public.ai_usage"));
    expect(Number(total[0].s)).toBeLessThanOrEqual(10);
  });
});
