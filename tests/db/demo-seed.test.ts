import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_TYPES, type ProjectType } from "@/lib/db/schema";
import { minorToDecimal } from "@/lib/journeys/money";
import { computeQuote, PricingRuleSchema, type PricingRule } from "@/lib/journeys/quote";
import { validateRequirements } from "@/lib/journeys/validation";
import { REQUIREMENTS } from "../unit/support/journey-fixtures";
import { Scenario, as, createAdmin, createDatabase, createUser, service, superuser } from "./support/harness";

const DEMO_SQL = readFileSync(path.join(process.cwd(), "supabase/demo/pricing_rules.demo.sql"), "utf8");

describe("demonstration pricing is separate, loads cleanly and prices every journey", () => {
  let db: PGlite;
  let customer: string;
  let admin: string;

  beforeAll(async () => {
    db = await createDatabase();
    customer = await createUser(db, "customer");
    admin = await createAdmin(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const loadRules = () =>
    as(db, service, (q) => q("select * from public.pricing_rules where is_active"))
      .then((rows) => rows.map((r) => PricingRuleSchema.parse({ ...r, effective_from: String(new Date(String(r.effective_from)).toISOString()), effective_until: null })) as PricingRule[]);

  it("the migrations seed no prices, so a fresh database means 'Pricing not configured'", async () => {
    expect(await loadRules()).toHaveLength(0);
    const settings = await as(db, service, (q) => q("select * from public.site_settings where key = 'pricing_mode'"));
    expect(settings).toHaveLength(0);
  });

  it("is not named like a file the Supabase CLI applies automatically", () => {
    expect(path.basename("supabase/demo/pricing_rules.demo.sql")).not.toBe("seed.sql");
    expect(DEMO_SQL).toMatch(/NEVER APPLY TO PRODUCTION/);
    expect(DEMO_SQL).toMatch(/unverified/i);
  });

  it("loads once, and again without duplicating rows", async () => {
    await db.exec(DEMO_SQL);
    await db.exec(DEMO_SQL);
    const rows = await loadRules();
    expect(rows).toHaveLength(17);
    const mode = await as(db, service, (q) => q<{ value_json: { mode: string } }>("select value_json from public.site_settings where key = 'pricing_mode'"));
    expect(mode[0].value_json.mode).toBe("demo");
  });

  it.each(PROJECT_TYPES)("produces a complete, demo-labelled quote for %s", async (type: ProjectType) => {
    const check = validateRequirements(type, { schemaVersion: 1, ...REQUIREMENTS[type] });
    if (!check.complete) throw new Error("fixture must be complete");
    const out = computeQuote({ type, requirements: check.requirements, rules: await loadRules(), isDemo: true, now: new Date() });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.quote.currency).toBe("INR");
    expect(out.quote.lines.length).toBeGreaterThanOrEqual(4);
    expect(out.quote.ruleVersion.startsWith("DEMO:")).toBe(true);
  });

  it("the quote shape the service writes satisfies the real constraints and guards, through acceptance", async () => {
    const check = validateRequirements("EMPTY_PLOT", { schemaVersion: 1, ...REQUIREMENTS.EMPTY_PLOT });
    if (!check.complete) throw new Error("fixture must be complete");
    const out = computeQuote({ type: "EMPTY_PLOT", requirements: check.requirements, rules: await loadRules(), isDemo: true, now: new Date() });
    if (out.status !== "ok") throw new Error("expected a quote");
    const q = out.quote;

    const s = await Scenario.create(db, customer, admin);
    await s.toBriefApproved();
    const inserted = await as(db, service, (x) =>
      x<{ id: string }>(
        `insert into public.quotes (project_id, currency, line_items_json, subtotal, tax_amount, discount_amount, total_amount, pricing_rule_version)
         values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8) returning id`,
        [s.projectId, q.currency, JSON.stringify(q.lines), minorToDecimal(q.subtotalMinor), minorToDecimal(q.taxMinor), minorToDecimal(q.discountMinor), minorToDecimal(q.totalMinor), q.ruleVersion],
      ),
    );
    s.quoteId = inserted[0].id;
    await s.setStatus(service, "QUOTED");
    await s.toAwaitingPayment();
    expect(await s.status()).toBe("AWAITING_PAYMENT");

    // The accepted snapshot is frozen: a later change of rates cannot alter it.
    await as(db, superuser, (x) => x("update public.pricing_rules set rate = rate * 10"));
    const stored = await as(db, service, (x) => x<{ total_amount: string }>("select total_amount from public.quotes where id = $1", [s.quoteId]));
    expect(Number(stored[0].total_amount) * 100).toBe(q.totalMinor);
  });
});
