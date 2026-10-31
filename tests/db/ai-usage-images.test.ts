import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, as, createUser, expectError, service, superuser, user } from "./support/harness";
import { createDatabase } from "./support/harness";

/**
 * Migration 9: image generation is metered in the AI usage ledger, in a unit of its own.
 * In-process Postgres only; real concurrency and PostgREST codes need the local stack.
 */
describe("ai_usage image metering (migration 9)", () => {
  let db: PGlite;
  let a: string;
  let b: string;

  beforeAll(async () => {
    db = await createDatabase();
    a = await createUser(db, "customer-a");
    b = await createUser(db, "customer-b");
  });
  afterAll(async () => {
    await db.close();
  });

  const reserve = (customer: string, p: { provider?: string; operation: string; unit: string; units: number; customerLimit?: number; globalLimit?: number; globalWindow?: number | null; inFlight?: number | null }) =>
    as(db, service, (q) =>
      q<{ id: string }>("select public.ai_usage_reserve($1, null, $2, $3, 'm', $4, $5::numeric, $6::numeric, 60, $7::numeric, $8, $9) as id", [
        customer,
        p.provider ?? "openrouter",
        p.operation,
        p.unit,
        p.units,
        p.customerLimit ?? 4,
        p.globalLimit ?? 10,
        p.globalWindow === undefined ? 1440 : p.globalWindow,
        p.inFlight === undefined ? null : p.inFlight,
      ]),
    );
  const image = (customer: string, units: number, extra: Partial<Parameters<typeof reserve>[1]> = {}) => reserve(customer, { operation: "image", unit: "image", units, ...extra });
  const brief = (customer: string, extra: Partial<Parameters<typeof reserve>[1]> = {}) => reserve(customer, { operation: "brief", unit: "request", units: 1, ...extra });
  const finish = (id: string, status: string, reported: number | null = null) => as(db, service, (q) => q("select public.ai_usage_finish($1, $2, $3, 'req-1')", [id, status, reported]));
  const wipe = () =>
    as(db, superuser, async (q) => {
      await q("alter table public.ai_usage disable trigger trg_10_ai_usage_guard");
      await q("delete from public.ai_usage");
      await q("alter table public.ai_usage enable trigger trg_10_ai_usage_guard");
    });
  const rows = () => as(db, superuser, (q) => q<{ provider: string; operation: string; unit: string; units_estimated: string; status: string }>("select provider, operation, unit, units_estimated::text, status from public.ai_usage order by created_at"));

  it("reserves images for OpenRouter, in the image unit", async () => {
    await wipe();
    const [{ id }] = await image(a, 2);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await rows()).toEqual([{ provider: "openrouter", operation: "image", unit: "image", units_estimated: "2.00", status: "RESERVED" }]);
    await finish(id, "SUCCEEDED", 2);
    expect((await rows())[0].status).toBe("SUCCEEDED");
  });

  it("refuses every other combination of provider, operation and unit", async () => {
    await wipe();
    const bad: [string, string, string, string][] = [
      ["openrouter", "image", "request", "images counted as briefs"],
      ["openrouter", "brief", "image", "briefs counted as images"],
      ["openrouter", "image", "credit", "images counted in credits"],
      ["gnani", "image", "image", "Gnani generating images"],
      ["gnani", "stt", "image", "Gnani speech counted as images"],
      ["other", "image", "image", "an unknown provider"],
    ];
    for (const [provider, operation, unit] of bad) {
      await expectError(reserve(a, { provider, operation, unit, units: 1 }), /unknown provider, operation or unit|violates check constraint/);
    }
    expect(await rows()).toEqual([]);
  });

  it("the table itself refuses a row that does not fit, even if the function were bypassed", async () => {
    await wipe();
    await expectError(
      as(db, superuser, (q) => q("insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated) values ($1, 'openrouter', 'image', 'request', 1)", [a])),
      /ai_usage_provider_shape/,
    );
    await expectError(
      as(db, superuser, (q) => q("insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated) values ($1, 'gnani', 'tts', 'image', 1)", [a])),
      /ai_usage_provider_shape/,
    );
  });

  it("keeps the image limits apart from the brief limits", async () => {
    await wipe();
    // The customer's image allowance (4) is used up without touching briefs...
    await image(a, 4);
    await expectError(image(a, 1), /customer usage limit reached/);
    // ...and briefs still work, because they are a different unit.
    await expect(brief(a, { customerLimit: 1 })).resolves.toHaveLength(1);
    // Using up the brief limit does not touch images of another customer either.
    await expectError(brief(a, { customerLimit: 1 }), /customer usage limit reached/);
    await expect(image(b, 4)).resolves.toHaveLength(1);
  });

  it("applies the app-wide image ceiling across customers", async () => {
    await wipe();
    await image(a, 4, { globalLimit: 6 });
    await expectError(image(b, 3, { globalLimit: 6 }), /provider usage ceiling reached/);
    await expect(image(b, 2, { globalLimit: 6 })).resolves.toHaveLength(1);
  });

  it("counts a request as the larger of its estimate and what was reported, and releases only NOT_SENT", async () => {
    await wipe();
    const [{ id: sent }] = await image(a, 2);
    await finish(sent, "FAILED", 0); // a failed call may still have been billed: it keeps counting
    await expectError(image(a, 3), /customer usage limit reached/);
    const [{ id: unsent }] = await image(a, 2);
    await finish(unsent, "NOT_SENT");
    await expect(image(a, 2)).resolves.toHaveLength(1); // the unsent reservation was released
  });

  it("refuses missing, zero, negative and fractional-below-minimum image amounts and limits (fail closed)", async () => {
    await wipe();
    await expectError(image(a, 0), /usage limits are missing or invalid/);
    await expectError(image(a, -1), /usage limits are missing or invalid/);
    await expectError(image(a, 1, { customerLimit: 0 }), /usage limits are missing or invalid/);
    await expectError(image(a, 1, { globalLimit: 0 }), /usage limits are missing or invalid/);
    expect(await rows()).toEqual([]);
  });

  it("allows one image request in flight at a time when asked", async () => {
    await wipe();
    await image(a, 1, { inFlight: 1 });
    await expectError(image(b, 1, { inFlight: 1 }), /too many calls in flight/);
  });

  it("is still service-only: customers, anonymous callers and the browser cannot reserve or read", async () => {
    await wipe();
    await expectError(as(db, user(a), (q) => q("select public.ai_usage_reserve($1, null, 'openrouter', 'image', 'm', 'image', 1, 4, 60, 10, 1440, null)", [a])), /permission denied/);
    await expectError(as(db, anon, (q) => q("select public.ai_usage_reserve($1, null, 'openrouter', 'image', 'm', 'image', 1, 4, 60, 10, 1440, null)", [a])), /permission denied/);
    await image(a, 1);
    expect(await as(db, user(a), (q) => q("select id from public.ai_usage"))).toEqual([]);
  });

  it("migration 9 changes only the ledger's allowed combinations (the function otherwise equals migration 7's)", () => {
    const root = process.cwd();
    const old = readFileSync(path.join(root, "supabase/migrations/20261018000200_ai_usage.sql"), "utf8");
    const next = readFileSync(path.join(root, "supabase/migrations/20261022000100_ai_usage_images.sql"), "utf8");
    const body = (text: string) => text.slice(text.indexOf("create or replace function public.ai_usage_reserve("), text.indexOf("$$;", text.indexOf("create or replace function public.ai_usage_reserve(")) + 3);
    const oldLines = body(old).split("\n");
    const newLines = body(next).split("\n");
    const added = newLines.filter((l) => !oldLines.includes(l));
    expect(added).toEqual(["          or (p_provider = 'openrouter' and p_operation = 'image' and p_unit = 'image')"]);
    expect(oldLines.filter((l) => !newLines.includes(l))).toEqual([]);
  });

  it("the rollback refuses to run while image rows exist, and restores migration 7's rules otherwise", async () => {
    await wipe();
    const root = process.cwd();
    const down = readFileSync(path.join(root, "supabase/rollbacks/20261022000100_ai_usage_images.down.sql"), "utf8");
    await image(a, 1);
    await expectError(db.exec(down), /image rows; they cannot be removed/);
    await wipe();
    await db.exec(down);
    await expectError(image(a, 1), /unknown provider, operation or unit/);
    await expect(brief(a)).resolves.toHaveLength(1);
    // re-apply migration 9 so later tests in this file see the final schema
    await db.exec(readFileSync(path.join(root, "supabase/migrations/20261022000100_ai_usage_images.sql"), "utf8"));
    await expect(image(b, 1)).resolves.toHaveLength(1);
  });
});
