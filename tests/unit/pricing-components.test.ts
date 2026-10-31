import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The form only calls this; the server side is tested in pricing-actions and pricing-admin tests.
vi.mock("@/app/(app)/admin/pricing/actions", () => ({ publishPricingRuleAction: vi.fn() }));

const { RuleForm } = await import("@/components/pricing/rule-form");

const DEFAULTS = { rate: "1200", unit: "floor", minimumCharge: "0", includedQuantity: "1", currency: "INR" };

describe("RuleForm", () => {
  it("asks for every value the engine uses, prefilled, with labels tied to unique fields", () => {
    const out = renderToStaticMarkup(createElement(RuleForm, { projectType: "EMPTY_PLOT", ruleKey: "layout_per_floor", isTax: false, defaults: DEFAULTS }));
    for (const name of ["rate", "unit", "minimumCharge", "includedQuantity", "currency"]) {
      expect(out).toContain(`for="EMPTY_PLOT-layout_per_floor-${name}"`);
      expect(out).toContain(`id="EMPTY_PLOT-layout_per_floor-${name}"`);
    }
    expect(out).toContain('value="1200"');
    expect(out).toContain('value="INR"');
    const checkbox = out.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
    expect(checkbox).toContain('name="confirm"');
    expect(checkbox).toMatch(/\srequired(="")?[\s/>]/);
    expect(out).toContain("Quotes already accepted do not change.");
    expect(out).toContain("Publish new version");
  });

  it("asks only for the percentage and currency for the tax rate", () => {
    const out = renderToStaticMarkup(createElement(RuleForm, { projectType: "INTERIOR", ruleKey: "tax_percent", isTax: true, defaults: { ...DEFAULTS, rate: "18" } }));
    expect(out).toContain("Tax rate (percent)");
    expect(out).toContain('id="INTERIOR-tax_percent-rate"');
    expect(out).toContain('id="INTERIOR-tax_percent-currency"');
    expect(out).not.toContain("INTERIOR-tax_percent-unit");
    expect(out).not.toContain("INTERIOR-tax_percent-minimumCharge");
    expect(out).not.toContain("INTERIOR-tax_percent-includedQuantity");
  });

  it("offers nothing for discounts or payment instructions", () => {
    const out = renderToStaticMarkup(createElement(RuleForm, { projectType: "LANDSCAPE", ruleKey: "base_fee", isTax: false, defaults: DEFAULTS }));
    expect(out).not.toMatch(/discount|UPI|bank|instruction/i);
  });

  // No DOM library is installed, so the reset itself is checked in a browser run (see the
  // completion report); this guards the code path against being removed.
  it("clears the one-time confirmation after a successful publish (the action answers undefined on success)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/pricing/rule-form.tsx", "utf8");
    expect(source).toContain("if (result === undefined) form.reset()");
  });
});
