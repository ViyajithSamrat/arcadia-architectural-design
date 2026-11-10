import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, as, createDatabase, createUser, expectError, service, superuser, user } from "./support/harness";

/**
 * Migration 13: transcript translations have their own per-customer allowance in the AI usage
 * ledger, apart from briefs, and still share the app-wide daily request cap.
 * In-process Postgres only; real concurrency and PostgREST codes need the local stack.
 */
describe("ai_usage translation allowance (migration 13)", () => {
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

  const reserve = (customer: string, p: { provider?: string; operation: string; unit: string; units?: number; customerLimit: number; globalLimit?: number }) =>
    as(db, service, (q) =>
      q<{ id: string }>("select public.ai_usage_reserve($1, null, $2, $3, 'm', $4, $5::numeric, $6::numeric, 60, $7::numeric, $8, null) as id", [
        customer,
        p.provider ?? "openrouter",
        p.operation,
        p.unit,
        p.units ?? 1,
        p.customerLimit,
        p.globalLimit ?? 5,
        (p.provider ?? "openrouter") === "gnani" ? null : 1440, // the Gnani ceiling is cumulative
      ]),
    );
  // The production limits: 3 briefs and 6 translations per customer per hour, 5 requests per day app-wide.
  const brief = (customer: string, globalLimit = 5) => reserve(customer, { operation: "brief", unit: "request", customerLimit: 3, globalLimit });
  const translate = (customer: string, globalLimit = 5) => reserve(customer, { operation: "translate", unit: "request", customerLimit: 6, globalLimit });
  const wipe = () =>
    as(db, superuser, async (q) => {
      await q("alter table public.ai_usage disable trigger trg_10_ai_usage_guard");
      await q("delete from public.ai_usage");
      await q("alter table public.ai_usage enable trigger trg_10_ai_usage_guard");
    });
  const rows = () => as(db, superuser, (q) => q<{ operation: string; unit: string }>("select operation, unit from public.ai_usage order by created_at"));

  it("reserves a translation as its own operation, in the request unit", async () => {
    await wipe();
    await translate(a);
    expect(await rows()).toEqual([{ operation: "translate", unit: "request" }]);
  });

  it("a translation does not use up the customer's brief allowance (the defect this fixes)", async () => {
    await wipe();
    await translate(a);
    await translate(a);
    // Before migration 13 these two translations counted as briefs; with a brief limit of 1 or 2
    // the customer could no longer create a brief for an hour.
    await expect(reserve(a, { operation: "brief", unit: "request", customerLimit: 1, globalLimit: 50 })).resolves.toHaveLength(1);
  });

  it("briefs do not use up the translation allowance either", async () => {
    await wipe();
    await brief(a, 50);
    await brief(a, 50);
    await brief(a, 50);
    await expectError(brief(a, 50), /customer usage limit reached/);
    await expect(reserve(a, { operation: "translate", unit: "request", customerLimit: 1, globalLimit: 50 })).resolves.toHaveLength(1);
  });

  it("enforces each allowance on its own", async () => {
    await wipe();
    for (let i = 0; i < 6; i += 1) await translate(a, 50);
    await expectError(translate(a, 50), /customer usage limit reached/);
    // another customer is unaffected
    await expect(translate(b, 50)).resolves.toHaveLength(1);
  });

  it("keeps ONE app-wide daily cap across briefs and translations (spending control unchanged)", async () => {
    await wipe();
    await brief(a);
    await brief(b);
    await translate(a);
    await translate(b);
    await translate(a); // 5 of 5 requests used today, across both operations and customers
    await expectError(brief(b), /provider usage ceiling reached/);
    await expectError(translate(b), /provider usage ceiling reached/);
  });

  it("accepts the application's unmetered limit for text: heavy past use never refuses, and every request is still recorded", async () => {
    await wipe();
    const unmetered = 1_000_000_000;
    // 60 briefs and translations already on the ledger inside the hour and the day: the old limits (3 and 6 an hour, 5 a day) would refuse.
    for (let i = 0; i < 30; i += 1) await reserve(a, { operation: "brief", unit: "request", customerLimit: unmetered, globalLimit: unmetered });
    for (let i = 0; i < 30; i += 1) await reserve(a, { operation: "translate", unit: "request", customerLimit: unmetered, globalLimit: unmetered });
    expect(await rows()).toHaveLength(60);
    // The Gnani cumulative ceiling is still clamped to 5,000 credits inside the function, whatever the caller sends.
    await expectError(reserve(a, { provider: "gnani", operation: "stt", unit: "credit", units: 5001, customerLimit: unmetered, globalLimit: 5000 }), /provider usage ceiling reached/);
    await expect(reserve(a, { provider: "gnani", operation: "stt", unit: "credit", units: 40, customerLimit: unmetered, globalLimit: 5000 })).resolves.toHaveLength(1);
  });

  it("leaves Gnani's shared credit allowance (STT plus TTS) and images unchanged", async () => {
    await wipe();
    await reserve(a, { provider: "gnani", operation: "stt", unit: "credit", units: 2, customerLimit: 3, globalLimit: 100 });
    await expectError(reserve(a, { provider: "gnani", operation: "tts", unit: "credit", units: 2, customerLimit: 3, globalLimit: 100 }), /customer usage limit reached/);
    await reserve(a, { operation: "image", unit: "image", customerLimit: 1, globalLimit: 10 });
    await expectError(reserve(a, { operation: "image", unit: "image", customerLimit: 1, globalLimit: 10 }), /customer usage limit reached/);
  });

  it("refuses translate in any other unit or for another provider, in the function and in the table", async () => {
    await wipe();
    await expectError(reserve(a, { operation: "translate", unit: "image", customerLimit: 6 }), /unknown provider, operation or unit/);
    await expectError(reserve(a, { operation: "translate", unit: "credit", customerLimit: 6 }), /unknown provider, operation or unit/);
    await expectError(reserve(a, { provider: "gnani", operation: "translate", unit: "credit", customerLimit: 6 }), /unknown provider, operation or unit/);
    await expectError(
      as(db, superuser, (q) => q("insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated) values ($1, 'openrouter', 'translate', 'image', 1)", [a])),
      /ai_usage_provider_shape/,
    );
    expect(await rows()).toEqual([]);
  });

  it("is still service-only: customers and anonymous callers cannot reserve a translation", async () => {
    await wipe();
    const call = "select public.ai_usage_reserve($1, null, 'openrouter', 'translate', 'm', 'request', 1, 6, 60, 5, 1440, null)";
    await expectError(as(db, user(a), (q) => q(call, [a])), /permission denied/);
    await expectError(as(db, anon, (q) => q(call, [a])), /permission denied/);
  });

  it("migration 13 changes only the allowed combination and the per-operation request count (otherwise equals migration 9)", () => {
    const root = process.cwd();
    const old = readFileSync(path.join(root, "supabase/migrations/20261022000100_ai_usage_images.sql"), "utf8");
    const next = readFileSync(path.join(root, "supabase/migrations/20261101000200_ai_usage_translate.sql"), "utf8");
    const body = (text: string) => text.slice(text.indexOf("create or replace function public.ai_usage_reserve("), text.indexOf("$$;", text.indexOf("create or replace function public.ai_usage_reserve(")) + 3);
    const oldLines = body(old).split("\n");
    const newLines = body(next).split("\n");
    expect(newLines.filter((l) => !oldLines.includes(l))).toEqual([
      "          or (p_provider = 'openrouter' and p_operation = 'translate' and p_unit = 'request')",
      "  -- A customer's limit is per provider and unit; OpenRouter requests are also counted per",
      "  -- operation, so briefs and translations each have their own allowance.",
      "     and (p_unit <> 'request' or u.operation = p_operation)",
    ]);
    expect(oldLines.filter((l) => !newLines.includes(l))).toEqual(["  -- All of this provider's operations share the customer's limit."]);
  });

  it("the rollback refuses to run while translate rows exist, and restores migration 9's rules otherwise", async () => {
    await wipe();
    const root = process.cwd();
    const down = readFileSync(path.join(root, "supabase/rollbacks/20261101000200_ai_usage_translate.down.sql"), "utf8");
    await translate(a);
    await expectError(db.exec(down), /translate rows; they cannot be removed/);
    await wipe();
    await db.exec(down);
    await expectError(translate(a), /unknown provider, operation or unit/);
    await expect(brief(a)).resolves.toHaveLength(1);
    // re-apply migration 13 so the database ends in the final schema
    await db.exec(readFileSync(path.join(root, "supabase/migrations/20261101000200_ai_usage_translate.sql"), "utf8"));
    await expect(translate(b)).resolves.toHaveLength(1);
  });
});
