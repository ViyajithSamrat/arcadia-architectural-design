import { z } from "zod";
import type { ProjectType } from "@/lib/db/schema";
import { toMinor } from "./money";
import type { StepData } from "./validation";

/**
 * Quote calculation (05_BACKEND_SCHEMA.md section 5.12). This module holds the
 * STRUCTURE of a quote: which lines exist for each project type and how many units of
 * each the customer's answers imply. It holds NO rates, taxes or currency: those come
 * from the pricing_rules table, so no price can be hard-coded into the application.
 *
 * Pure functions only; reading the rules and saving the quote happen in the service layer.
 */

/** A quote line asks for a pricing rule by key. Keys are the contract with pricing_rules.rule_key. */
type LineSpec = {
  key: string;
  label: string;
  quantity: (r: Record<string, StepData>) => number;
};

/** Structure assumption: the planting rule is priced per block of this many square feet. */
export const PLANTING_BLOCK_SQFT = 500;
const SQFT_PER_SQM = 10.7639;

export const TAX_RULE_KEY = "tax_percent";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const QUOTE_LINES: Readonly<Record<ProjectType, readonly LineSpec[]>> = {
  EMPTY_PLOT: [
    { key: "base_fee", label: "Brief and project setup", quantity: () => 1 },
    { key: "layout_per_floor", label: "Illustrative 2D layout", quantity: (r) => num(r.space?.floors) },
    { key: "exterior_view", label: "Exterior concept views", quantity: (r) => num(r.preferences?.exteriorViews) },
    { key: "interior_view", label: "Interior concept views", quantity: (r) => num(r.preferences?.interiorViews) },
    { key: "garden_concept", label: "Front garden concept", quantity: (r) => (r.preferences?.frontGarden === true ? 1 : 0) },
  ],
  INTERIOR: [
    { key: "base_fee", label: "Brief and project setup", quantity: () => 1 },
    { key: "room_concept", label: "Room concepts", quantity: (r) => (Array.isArray(r.space?.rooms) ? r.space.rooms.length : 0) },
    {
      key: "room_view",
      label: "Concept views",
      quantity: (r) => (Array.isArray(r.space?.rooms) ? r.space.rooms.length : 0) * num(r.preferences?.viewsPerRoom),
    },
    { key: "material_sheet", label: "Material and colour sheet", quantity: (r) => (r.preferences?.materialSheet === true ? 1 : 0) },
  ],
  LANDSCAPE: [
    { key: "base_fee", label: "Brief and project setup", quantity: () => 1 },
    { key: "site_concept", label: "Garden concept set", quantity: () => 1 },
    { key: "concept_view", label: "Concept views", quantity: (r) => num(r.features?.views) },
    {
      key: "planting_per_block",
      label: "Planting suggestions",
      quantity: (r) => {
        const sqft = num(r.area?.approxArea) * (r.area?.areaUnit === "sqm" ? SQFT_PER_SQM : 1);
        return Math.max(1, Math.ceil(sqft / PLANTING_BLOCK_SQFT));
      },
    },
    { key: "seating_concept", label: "Seating area concept", quantity: (r) => (r.features?.seating === true ? 1 : 0) },
  ],
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const PricingRuleSchema = z.object({
  id: z.string(),
  project_type: z.enum(["EMPTY_PLOT", "INTERIOR", "LANDSCAPE"]),
  rule_key: z.string(),
  rate: z.coerce.number().nonnegative(),
  unit: z.string(),
  minimum_charge: z.coerce.number().nonnegative(),
  included_quantity: z.coerce.number().nonnegative(),
  add_on_rate: z.coerce.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  effective_from: z.string(),
  effective_until: z.string().nullable(),
  version: z.number().int().positive(),
  is_active: z.boolean(),
});
export type PricingRule = z.infer<typeof PricingRuleSchema>;

/**
 * The rule in force for each key: active, inside its effective window, highest version.
 * Rules for other project types are ignored.
 */
export function selectRules(rows: readonly PricingRule[], type: ProjectType, now: Date): Map<string, PricingRule> {
  const chosen = new Map<string, PricingRule>();
  for (const rule of rows) {
    if (rule.project_type !== type || !rule.is_active) continue;
    if (new Date(rule.effective_from) > now) continue;
    if (rule.effective_until !== null && new Date(rule.effective_until) <= now) continue;
    const current = chosen.get(rule.rule_key);
    if (!current || rule.version > current.version) chosen.set(rule.rule_key, rule);
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export const QuoteLineItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  quantity: z.number(),
  unit: z.string(),
  rateMinor: z.number().int(),
  includedQuantity: z.number(),
  amountMinor: z.number().int(),
});
export type QuoteLineItem = z.infer<typeof QuoteLineItemSchema>;

export type ComputedQuote = {
  currency: string;
  lines: QuoteLineItem[];
  subtotalMinor: number;
  taxMinor: number;
  taxPercent: number;
  discountMinor: number;
  totalMinor: number;
  /** Frozen on the quote so a later rate change cannot silently alter it. */
  ruleVersion: string;
  isDemo: boolean;
};

export type QuoteOutcome =
  | { status: "ok"; quote: ComputedQuote }
  | { status: "not_configured"; reason: "no_rules" | "missing_rules" | "mixed_currency"; missingKeys: string[] };

/**
 * Prefix on pricing_rule_version for quotes built from rates flagged as demonstration
 * values (see supabase/demo). The interface shows a "Demo rates" label for these.
 */
export const DEMO_VERSION_PREFIX = "DEMO:";

export function isDemoVersion(version: string): boolean {
  return version.startsWith(DEMO_VERSION_PREFIX);
}

export function computeQuote(args: {
  type: ProjectType;
  requirements: Record<string, StepData>;
  rules: readonly PricingRule[];
  isDemo: boolean;
  now: Date;
}): QuoteOutcome {
  const inForce = selectRules(args.rules, args.type, args.now);
  if (inForce.size === 0) return { status: "not_configured", reason: "no_rules", missingKeys: [] };

  const wanted = QUOTE_LINES[args.type]
    .map((spec) => ({ spec, quantity: spec.quantity(args.requirements) }))
    .filter((l) => l.quantity > 0);

  const missingKeys = [...wanted.map((l) => l.spec.key), TAX_RULE_KEY].filter((k) => !inForce.has(k));
  if (missingKeys.length > 0) return { status: "not_configured", reason: "missing_rules", missingKeys };

  const usedRules = [...wanted.map((l) => inForce.get(l.spec.key)!), inForce.get(TAX_RULE_KEY)!];
  const currency = usedRules[0].currency;
  if (usedRules.some((r) => r.currency !== currency)) {
    return { status: "not_configured", reason: "mixed_currency", missingKeys: [] };
  }

  const lines: QuoteLineItem[] = wanted.map(({ spec, quantity }) => {
    const rule = inForce.get(spec.key)!;
    const rateMinor = toMinor(rule.rate);
    const billable = Math.max(0, quantity - rule.included_quantity);
    const raw = Math.round(billable * rateMinor);
    return {
      key: spec.key,
      label: spec.label,
      quantity,
      unit: rule.unit,
      rateMinor,
      includedQuantity: rule.included_quantity,
      amountMinor: Math.max(raw, toMinor(rule.minimum_charge)),
    };
  });

  const subtotalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
  const tax = inForce.get(TAX_RULE_KEY)!;
  // The tax rate has two decimals, so work in hundredths of a percent to stay in integers.
  const taxMinor = Math.round((subtotalMinor * Math.round(tax.rate * 100)) / 10000);
  const versions = [...usedRules]
    .sort((a, b) => a.rule_key.localeCompare(b.rule_key))
    .map((r) => `${r.rule_key}@${r.version}`)
    .join(",");

  return {
    status: "ok",
    quote: {
      currency,
      lines,
      subtotalMinor,
      taxMinor,
      taxPercent: tax.rate,
      discountMinor: 0,
      totalMinor: subtotalMinor + taxMinor,
      ruleVersion: `${args.isDemo ? DEMO_VERSION_PREFIX : ""}${versions}`,
      isDemo: args.isDemo,
    },
  };
}
