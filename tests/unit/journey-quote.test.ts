import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectType } from "@/lib/db/schema";
import { formatMoney, minorToDecimal, toMinor } from "@/lib/journeys/money";
import {
  computeQuote,
  DEMO_VERSION_PREFIX,
  isDemoVersion,
  QUOTE_LINES,
  selectRules,
  TAX_RULE_KEY,
  type PricingRule,
} from "@/lib/journeys/quote";
import { validateRequirements } from "@/lib/journeys/validation";
import { REQUIREMENTS } from "./support/journey-fixtures";

// Round "test" numbers, on the fake ISO code XTS: nothing here is a real rate.
const NOW = new Date("2026-06-01T00:00:00Z");

function rule(type: ProjectType, key: string, rate: number, extra: Partial<PricingRule> = {}): PricingRule {
  return {
    id: `${type}-${key}-${extra.version ?? 1}`,
    project_type: type,
    rule_key: key,
    rate,
    unit: "unit",
    minimum_charge: 0,
    included_quantity: 0,
    add_on_rate: 0,
    currency: "XTS",
    effective_from: "2026-01-01T00:00:00Z",
    effective_until: null,
    version: 1,
    is_active: true,
    ...extra,
  };
}

/** Rate 10 for every line the type can request, plus 10% tax. */
function fullRules(type: ProjectType): PricingRule[] {
  return [...QUOTE_LINES[type].map((l) => rule(type, l.key, 10)), rule(type, TAX_RULE_KEY, 10, { unit: "percent" })];
}

function requirements(type: ProjectType, patch: Record<string, Record<string, unknown>> = {}) {
  const check = validateRequirements(type, { schemaVersion: 1, ...REQUIREMENTS[type] });
  if (!check.complete) throw new Error("fixture must be complete");
  const merged: Record<string, Record<string, unknown>> = { ...check.requirements };
  for (const [step, values] of Object.entries(patch)) merged[step] = { ...merged[step], ...values };
  return merged;
}

const quoteFor = (type: ProjectType, rules: PricingRule[], reqs = requirements(type), isDemo = false) =>
  computeQuote({ type, requirements: reqs, rules, isDemo, now: NOW });

describe("quote lines follow the customer's answers", () => {
  it("empty plot: 2 floors, 4 exterior, 2 interior views and a garden", () => {
    const out = quoteFor("EMPTY_PLOT", fullRules("EMPTY_PLOT"));
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.quote.lines.map((l) => [l.key, l.quantity, l.amountMinor])).toEqual([
      ["base_fee", 1, 1000],
      ["layout_per_floor", 2, 2000],
      ["exterior_view", 4, 4000],
      ["interior_view", 2, 2000],
      ["garden_concept", 1, 1000],
    ]);
    expect(out.quote.subtotalMinor).toBe(10000);
    expect(out.quote.taxMinor).toBe(1000);
    expect(out.quote.totalMinor).toBe(11000);
    expect(out.quote.totalMinor).toBe(out.quote.subtotalMinor + out.quote.taxMinor - out.quote.discountMinor);
  });

  it("omits optional lines the customer did not ask for, and needs no rule for them", () => {
    const reqs = requirements("EMPTY_PLOT", { preferences: { frontGarden: false, interiorViews: 0 } });
    const rules = fullRules("EMPTY_PLOT").filter((r) => !["garden_concept", "interior_view"].includes(r.rule_key));
    const out = quoteFor("EMPTY_PLOT", rules, reqs);
    expect(out.status).toBe("ok");
    if (out.status === "ok") expect(out.quote.lines.map((l) => l.key)).not.toContain("garden_concept");
  });

  it("interior: rooms and views scale with the number of rooms", () => {
    const out = quoteFor("INTERIOR", fullRules("INTERIOR"));
    if (out.status !== "ok") throw new Error("expected a quote");
    const byKey = Object.fromEntries(out.quote.lines.map((l) => [l.key, l.quantity]));
    expect(byKey).toMatchObject({ room_concept: 2, room_view: 4, material_sheet: 1 });
  });

  it("landscape: planting is charged per started 500 sq ft block, with square metres converted", () => {
    const sqft = quoteFor("LANDSCAPE", fullRules("LANDSCAPE"));
    if (sqft.status !== "ok") throw new Error("expected a quote");
    expect(sqft.quote.lines.find((l) => l.key === "planting_per_block")?.quantity).toBe(3); // 1200 / 500, rounded up
    const sqm = quoteFor("LANDSCAPE", fullRules("LANDSCAPE"), requirements("LANDSCAPE", { area: { approxArea: 100, areaUnit: "sqm" } }));
    if (sqm.status !== "ok") throw new Error("expected a quote");
    expect(sqm.quote.lines.find((l) => l.key === "planting_per_block")?.quantity).toBe(3); // 1076 sq ft
  });

  it("each type produces a different set of lines", () => {
    const keys = (t: ProjectType) => {
      const out = quoteFor(t, fullRules(t));
      return out.status === "ok" ? out.quote.lines.map((l) => l.key).join() : "";
    };
    expect(new Set([keys("EMPTY_PLOT"), keys("INTERIOR"), keys("LANDSCAPE")]).size).toBe(3);
  });
});

describe("rule semantics", () => {
  it("applies included quantity and minimum charge", () => {
    const rules = fullRules("EMPTY_PLOT").map((r) =>
      r.rule_key === "exterior_view" ? { ...r, included_quantity: 3 } : r.rule_key === "garden_concept" ? { ...r, rate: 1, minimum_charge: 50 } : r,
    );
    const out = quoteFor("EMPTY_PLOT", rules);
    if (out.status !== "ok") throw new Error("expected a quote");
    const line = (k: string) => out.quote.lines.find((l) => l.key === k)!;
    expect(line("exterior_view").amountMinor).toBe(1000); // 4 requested, 3 included, 1 billed
    expect(line("garden_concept").amountMinor).toBe(5000); // minimum applies
  });

  it("uses the highest version in force and ignores inactive, expired and future rules", () => {
    const base = fullRules("EMPTY_PLOT");
    const rules = [
      ...base,
      rule("EMPTY_PLOT", "base_fee", 99, { version: 2 }),
      rule("EMPTY_PLOT", "base_fee", 500, { version: 3, is_active: false }),
      rule("EMPTY_PLOT", "base_fee", 600, { version: 4, effective_until: "2026-02-01T00:00:00Z" }),
      rule("EMPTY_PLOT", "base_fee", 700, { version: 5, effective_from: "2027-01-01T00:00:00Z" }),
      rule("INTERIOR", "base_fee", 800, { version: 9 }),
    ];
    expect(selectRules(rules, "EMPTY_PLOT", NOW).get("base_fee")?.rate).toBe(99);
  });

  it("rounds tax in whole minor units without floating point drift", () => {
    const rules = fullRules("EMPTY_PLOT").map((r) =>
      r.rule_key === TAX_RULE_KEY ? { ...r, rate: 18 } : r.rule_key === "base_fee" ? { ...r, rate: 0.07 } : { ...r, rate: 0.01 },
    );
    const out = quoteFor("EMPTY_PLOT", rules);
    if (out.status !== "ok") throw new Error("expected a quote");
    expect(Number.isInteger(out.quote.taxMinor)).toBe(true);
    expect(out.quote.totalMinor).toBe(out.quote.subtotalMinor + out.quote.taxMinor);
  });

  it("freezes the rule versions in the quote, with a demo marker only for demo rates", () => {
    const live = quoteFor("INTERIOR", fullRules("INTERIOR"));
    const demo = quoteFor("INTERIOR", fullRules("INTERIOR"), requirements("INTERIOR"), true);
    if (live.status !== "ok" || demo.status !== "ok") throw new Error("expected quotes");
    expect(live.quote.ruleVersion).toContain("base_fee@1");
    expect(isDemoVersion(live.quote.ruleVersion)).toBe(false);
    expect(demo.quote.ruleVersion.startsWith(DEMO_VERSION_PREFIX)).toBe(true);
    expect(demo.quote.isDemo).toBe(true);
  });
});

describe("pricing not configured", () => {
  it("refuses to quote when there are no rules at all", () => {
    expect(quoteFor("EMPTY_PLOT", [])).toEqual({ status: "not_configured", reason: "no_rules", missingKeys: [] });
  });

  it("refuses when rules exist only for another project type", () => {
    expect(quoteFor("EMPTY_PLOT", fullRules("INTERIOR")).status).toBe("not_configured");
  });

  it("names the missing rate and does not fall back to a default", () => {
    const rules = fullRules("EMPTY_PLOT").filter((r) => r.rule_key !== "exterior_view");
    expect(quoteFor("EMPTY_PLOT", rules)).toEqual({ status: "not_configured", reason: "missing_rules", missingKeys: ["exterior_view"] });
  });

  it("does not assume zero tax when no tax rule exists", () => {
    const rules = fullRules("EMPTY_PLOT").filter((r) => r.rule_key !== TAX_RULE_KEY);
    const out = quoteFor("EMPTY_PLOT", rules);
    expect(out).toMatchObject({ status: "not_configured", missingKeys: [TAX_RULE_KEY] });
  });

  it("refuses when the rates mix currencies", () => {
    const rules = fullRules("EMPTY_PLOT").map((r, i) => (i === 1 ? { ...r, currency: "XTT" } : r));
    expect(quoteFor("EMPTY_PLOT", rules)).toMatchObject({ status: "not_configured", reason: "mixed_currency" });
  });
});

describe("money helpers", () => {
  it("converts to integer minor units without drift", () => {
    expect(toMinor("1500.00")).toBe(150000);
    expect(toMinor(1100.1)).toBe(110010);
    expect(toMinor(0.07)).toBe(7);
    expect(() => toMinor("abc")).toThrow();
  });

  it("formats minor units for numeric(12,2) columns", () => {
    expect(minorToDecimal(0)).toBe("0.00");
    expect(minorToDecimal(5)).toBe("0.05");
    expect(minorToDecimal(123456)).toBe("1234.56");
    expect(minorToDecimal(-250)).toBe("-2.50");
    expect(() => minorToDecimal(1.5)).toThrow();
  });

  it("formats for display and tolerates an unknown currency code", () => {
    expect(formatMoney(150000, "INR")).toMatch(/1,500\.00/);
    expect(formatMoney(150000, "XTS")).toMatch(/1,?500\.00/);
  });
});

/** PR-026 / 5.12: rates, taxes and currency symbols must not be written into the interface. */
describe("no prices in the interface code", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(tsx?|css)$/.test(name) ? [full] : [];
    });
  }

  it("has no currency symbols, GST or hard-coded rate tables in components or pages", () => {
    const root = process.cwd();
    const files = [...sourceFiles(path.join(root, "src/components")), ...sourceFiles(path.join(root, "src/app"))];
    const offenders = files.filter((f) => /[₹$€£]\s?\d|\bGST\b|\bRATES\b/.test(readFileSync(f, "utf8").replace(/\$\{/g, "")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
