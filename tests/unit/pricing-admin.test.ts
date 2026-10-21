import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { QUOTE_LINES, TAX_RULE_KEY } from "@/lib/journeys/quote";
import { getPricingOverview, pricingKeys, publishRuleVersion } from "@/lib/pricing/admin";
import { FakeDb } from "./support/fake-supabase";

const NOW = new Date("2026-10-21T10:00:00.000Z");
const PAST = "2026-10-01T00:00:00.000Z";
const FUTURE = "2026-11-01T00:00:00.000Z";

/** A pricing_rules row as PostgREST returns it (numeric columns arrive as strings). */
const rule = (rule_key: string, patch: Record<string, unknown> = {}) => ({
  id: `${rule_key}-${String(patch.version ?? 1)}-${String(patch.project_type ?? "EMPTY_PLOT")}`,
  project_type: "EMPTY_PLOT",
  rule_key,
  rate: "1200.00",
  unit: "floor",
  minimum_charge: "0.00",
  included_quantity: "0.00",
  add_on_rate: "0.00",
  currency: "INR",
  effective_from: PAST,
  effective_until: null,
  version: 1,
  is_active: true,
  ...patch,
});

const VALID = { projectType: "EMPTY_PLOT", ruleKey: "layout_per_floor", rate: 1500, unit: "floor", minimumCharge: 0, includedQuantity: 0, currency: "INR" };
const inserts = (db: FakeDb) => db.writes.filter((w) => w.table === "pricing_rules" && w.op === "insert");

describe("pricingKeys", () => {
  it("offers exactly the keys the quote engine reads, then the tax rate", () => {
    for (const type of ["EMPTY_PLOT", "INTERIOR", "LANDSCAPE"] as const) {
      const keys = pricingKeys(type);
      expect(keys.map((k) => k.key)).toEqual([...QUOTE_LINES[type].map((l) => l.key), TAX_RULE_KEY]);
      expect(keys.filter((k) => k.isTax).map((k) => k.key)).toEqual([TAX_RULE_KEY]);
    }
  });
});

describe("publishRuleVersion", () => {
  it("publishes version 1 of a rule that has never been priced, in force from now", async () => {
    const db = new FakeDb();
    expect(await publishRuleVersion(db.client(), VALID, NOW)).toEqual({ ok: true, version: 1 });
    expect(inserts(db).map((w) => w.payload)).toEqual([
      {
        project_type: "EMPTY_PLOT",
        rule_key: "layout_per_floor",
        rate: 1500,
        unit: "floor",
        minimum_charge: 0,
        included_quantity: 0,
        add_on_rate: 0,
        currency: "INR",
        effective_from: NOW.toISOString(),
        effective_until: null,
        version: 1,
        is_active: true,
      },
    ]);
  });

  it("never edits a row: it adds the next version after every earlier one and carries the unused add-on rate over", async () => {
    const db = new FakeDb().seed("pricing_rules", [
      rule("layout_per_floor", { version: 1, add_on_rate: "25.00" }),
      rule("layout_per_floor", { version: 3, is_active: false }),
      rule("base_fee", { version: 7, unit: "project" }),
    ]);
    expect(await publishRuleVersion(db.client(), { ...VALID, rate: 1350.5, includedQuantity: 1, minimumCharge: 900 }, NOW)).toEqual({ ok: true, version: 4 });
    expect(db.writes.filter((w) => w.op !== "insert")).toEqual([]);
    expect(inserts(db)[0].payload).toMatchObject({ version: 4, rate: 1350.5, included_quantity: 1, minimum_charge: 900, add_on_rate: 25 });
  });

  it("stores the tax rate as a percentage with no unit choice, minimum or included quantity", async () => {
    const db = new FakeDb();
    const result = await publishRuleVersion(db.client(), { ...VALID, ruleKey: TAX_RULE_KEY, rate: 18.5, unit: "whatever", minimumCharge: 5, includedQuantity: 2 }, NOW);
    expect(result).toEqual({ ok: true, version: 1 });
    expect(inserts(db)[0].payload).toMatchObject({ rule_key: TAX_RULE_KEY, rate: 18.5, unit: "percent", minimum_charge: 0, included_quantity: 0 });
  });

  it("refuses a tax rate above 100 percent", async () => {
    const db = new FakeDb();
    const result = await publishRuleVersion(db.client(), { ...VALID, ruleKey: TAX_RULE_KEY, rate: 100.01 }, NOW);
    expect(result).toMatchObject({ ok: false, fieldErrors: { rate: "Enter a percentage from 0 to 100." } });
    expect(inserts(db)).toHaveLength(0);
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ["a negative rate", { rate: -1 }, "rate"],
    ["a NaN rate", { rate: Number.NaN }, "rate"],
    ["an infinite rate", { rate: Number.POSITIVE_INFINITY }, "rate"],
    ["three decimals", { rate: 1.005 }, "rate"],
    ["an amount above numeric(12,2)", { rate: 1e11 }, "rate"],
    ["a rate sent as text", { rate: "100" }, "rate"],
    ["a missing rate", { rate: undefined }, "rate"],
    ["a negative minimum", { minimumCharge: -5 }, "minimumCharge"],
    ["a negative included quantity", { includedQuantity: -1 }, "includedQuantity"],
    ["an empty unit", { unit: "  " }, "unit"],
    ["markup as a unit", { unit: "<b>floor</b>" }, "unit"],
    ["an overlong unit", { unit: "a".repeat(25) }, "unit"],
    ["a lower-case currency", { currency: "inr" }, "currency"],
    ["a four-letter currency", { currency: "INRX" }, "currency"],
    ["an unknown project type", { projectType: "VILLA" }, "projectType"],
    ["an extra field", { discount: 10 }, "_form"],
  ];
  it.each(invalid)("refuses %s and writes nothing", async (_name, patch, field) => {
    const db = new FakeDb();
    const result = await publishRuleVersion(db.client(), { ...VALID, ...patch }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.[field]).toBeTruthy();
    expect(db.writes).toHaveLength(0);
  });

  it.each([null, "rate=1", [], 42])("refuses a non-object (%s)", async (value) => {
    const db = new FakeDb();
    expect((await publishRuleVersion(db.client(), value, NOW)).ok).toBe(false);
    expect(db.writes).toHaveLength(0);
  });

  it("refuses a key that belongs to another project type or to no quote line", async () => {
    for (const patch of [{ projectType: "INTERIOR", ruleKey: "garden_concept" }, { ruleKey: "discount" }, { ruleKey: "__proto__" }]) {
      const db = new FakeDb();
      expect(await publishRuleVersion(db.client(), { ...VALID, ...patch }, NOW)).toEqual({ ok: false, message: "That rate does not exist for this project type." });
      expect(db.writes).toHaveLength(0);
    }
  });

  it("keeps one currency per project type, because the engine refuses mixed currencies", async () => {
    const db = new FakeDb().seed("pricing_rules", [rule("base_fee", { unit: "project" })]);
    const result = await publishRuleVersion(db.client(), { ...VALID, currency: "USD" }, NOW);
    expect(result).toMatchObject({ ok: false, fieldErrors: { currency: "Every rate for this project type uses INR. Use the same currency." } });
    expect(inserts(db)).toHaveLength(0);
  });

  it("allows a new currency when no other rate of the type is in force", async () => {
    const lone = new FakeDb().seed("pricing_rules", [rule("layout_per_floor")]);
    expect(await publishRuleVersion(lone.client(), { ...VALID, currency: "USD" }, NOW)).toEqual({ ok: true, version: 2 });
    // a rate only scheduled for later, another type, or a deactivated rate is not in force
    const elsewhere = new FakeDb().seed("pricing_rules", [
      rule("base_fee", { effective_from: FUTURE }),
      rule("base_fee", { project_type: "INTERIOR" }),
      rule("exterior_view", { is_active: false }),
    ]);
    expect((await publishRuleVersion(elsewhere.client(), { ...VALID, currency: "USD" }, NOW)).ok).toBe(true);
  });

  it("reports a simultaneous publish of the same version as a conflict, and other failures as not saved", async () => {
    const conflict = new FakeDb();
    conflict.failNext = { table: "pricing_rules", op: "insert", code: "23505" };
    expect(await publishRuleVersion(conflict.client(), VALID, NOW)).toEqual({ ok: false, message: "Someone else changed this rate at the same moment. Reload the page and try again." });

    const failing = new FakeDb();
    failing.failNext = { table: "pricing_rules", op: "insert" };
    expect(await publishRuleVersion(failing.client(), VALID, NOW)).toEqual({ ok: false, message: "The rate could not be saved. Nothing was changed." });
  });

  it("writes nothing when the existing rules cannot be read", async () => {
    const insertCalls: unknown[] = [];
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "denied" } }) }) }),
        insert: (row: unknown) => {
          insertCalls.push(row);
          return { select: async () => ({ data: [], error: null }) };
        },
      }),
    } as unknown as SupabaseClient;
    expect(await publishRuleVersion(client, VALID, NOW)).toEqual({ ok: false, message: "The rate could not be saved. Nothing was changed." });
    expect(insertCalls).toHaveLength(0);
  });
});

describe("getPricingOverview", () => {
  const seeded = () =>
    new FakeDb()
      .seed("pricing_rules", [
        rule("base_fee", { unit: "project", version: 1 }),
        rule("base_fee", { unit: "project", version: 2, rate: "9999.00", effective_from: FUTURE }),
        rule("layout_per_floor", { version: 1 }),
        rule("layout_per_floor", { version: 2, rate: "1300.00" }),
        rule(TAX_RULE_KEY, { unit: "percent", rate: "18.00" }),
        rule("base_fee", { project_type: "INTERIOR", currency: "USD", unit: "project" }),
        rule("room_concept", { project_type: "INTERIOR", unit: "room" }),
      ])
      .seed("site_settings", [{ key: "pricing_mode", value_json: { mode: "demo" } }]);

  it("shows the version in force for every key, how many versions exist, and what is not priced", async () => {
    const overview = await getPricingOverview(seeded().client(), NOW);
    expect(overview?.demoRates).toBe(true);
    const plot = overview!.types.find((t) => t.type === "EMPTY_PLOT")!;
    const byKey = Object.fromEntries(plot.rows.map((r) => [r.key, r]));
    expect(byKey.base_fee.current).toMatchObject({ version: 1, rate: 1200 });
    expect(byKey.base_fee.versions).toBe(2);
    expect(byKey.layout_per_floor.current).toMatchObject({ version: 2, rate: 1300, unit: "floor", currency: "INR" });
    expect(byKey[TAX_RULE_KEY].current).toMatchObject({ rate: 18, unit: "percent" });
    expect(plot.currency).toBe("INR");
    expect(plot.mixedCurrency).toBe(false);
    expect(plot.missing).toEqual(["Exterior concept views", "Interior concept views", "Front garden concept"]);
  });

  it("flags a project type whose rates mix currencies", async () => {
    const interior = (await getPricingOverview(seeded().client(), NOW))!.types.find((t) => t.type === "INTERIOR")!;
    expect(interior.mixedCurrency).toBe(true);
    expect(interior.currency).toBeNull();
  });

  it("shows an unpriced project type as entirely missing, and no demo label without the demo setting", async () => {
    const overview = await getPricingOverview(new FakeDb().client(), NOW);
    expect(overview?.demoRates).toBe(false);
    const landscape = overview!.types.find((t) => t.type === "LANDSCAPE")!;
    expect(landscape.rows.every((r) => r.current === null && r.versions === 0)).toBe(true);
    expect(landscape.missing).toHaveLength(landscape.rows.length);
  });

  it("returns null when the rules cannot be read", async () => {
    const client = {
      from: (table: string) => ({
        select: () =>
          table === "pricing_rules"
            ? { limit: async () => ({ data: null, error: { message: "denied" } }) }
            : { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) },
      }),
    } as unknown as SupabaseClient;
    expect(await getPricingOverview(client, NOW)).toBeNull();
  });
});
