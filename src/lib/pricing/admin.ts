import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { PROJECT_TYPES, type ProjectType } from "@/lib/db/schema";
import { PricingRuleSchema, QUOTE_LINES, selectRules, TAX_RULE_KEY, type PricingRule } from "@/lib/journeys/quote";

/**
 * Administrator pricing settings (PR-024; 06_IMPLEMENTATION_PLAN.md section 6.8).
 *
 * A change never edits a rule. It publishes a NEW VERSION, in force from the moment it is saved,
 * and the quote engine (selectRules) uses the highest active version in force. Older versions
 * stay as history, and an accepted quote keeps its frozen line items and pricing_rule_version
 * (PR-027), so a change reaches only quotes created after it.
 *
 * Every read and write uses the administrator's own session: row level security lets only
 * administrators read or insert pricing rules (pricing_rules_admin_all), and the database trigger
 * trg_90_pricing_rules_audit records who published what. Only the keys the quote engine reads
 * can be priced, and all rates of a project type must share one currency, because the engine
 * refuses mixed currencies.
 *
 * Deliberately not here (owner decisions): discounts (the engine has none), payment instructions
 * (protected server configuration, see src/lib/payments/config.ts) and switching quotes between
 * "Demo rates" and real rates (the pricing_mode setting).
 */

type Client = SupabaseClient;

export type PricingKey = { key: string; label: string; isTax: boolean };

/** What can be priced for a project type: the quote's lines, then the tax rate. */
export function pricingKeys(type: ProjectType): PricingKey[] {
  return [...QUOTE_LINES[type].map((line) => ({ key: line.key, label: line.label, isTax: false })), { key: TAX_RULE_KEY, label: "Tax rate", isTax: true }];
}

/** The largest value a numeric(12,2) column holds. */
export const MAX_AMOUNT = 9_999_999_999.99;
export const MAX_TAX_PERCENT = 100;
export const TAX_UNIT = "percent";

const amount = z
  .number({ error: "Enter a number." })
  .refine(Number.isFinite, "Enter a number.")
  .min(0, "Enter 0 or more.")
  .max(MAX_AMOUNT, "That amount is too large.")
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "Use at most two decimal places.");

const PublishSchema = z.strictObject({
  projectType: z.enum(PROJECT_TYPES),
  ruleKey: z.string().max(60),
  rate: amount,
  unit: z
    .string({ error: "Enter a unit." })
    .trim()
    .min(1, "Enter a unit.")
    .max(24, "Keep the unit under 24 characters.")
    .regex(/^[A-Za-z][A-Za-z0-9 ./-]*$/, "Use letters, numbers, spaces, dots, hyphens or slashes, starting with a letter."),
  minimumCharge: amount,
  includedQuantity: amount,
  currency: z.string({ error: "Enter a currency code." }).regex(/^[A-Z]{3}$/, "Use a three-letter currency code in capitals."),
});

export type PublishResult = { ok: true; version: number } | { ok: false; message: string; fieldErrors?: Record<string, string> };

const INVALID = "Please fix the highlighted values. Nothing was saved.";
const NOT_SAVED = "The rate could not be saved. Nothing was changed.";
const CONFLICT = "Someone else changed this rate at the same moment. Reload the page and try again.";

function readRules(rows: unknown[]): PricingRule[] {
  const rules: PricingRule[] = [];
  for (const row of rows) {
    const parsed = PricingRuleSchema.safeParse(row);
    if (parsed.success) rules.push(parsed.data);
  }
  return rules;
}

/**
 * Publishes a new version of one pricing rule. The caller must already have checked the
 * administrator role; row level security refuses the insert for anyone else in any case.
 */
export async function publishRuleVersion(supabase: Client, raw: unknown, now: Date = new Date()): Promise<PublishResult> {
  const parsed = PublishSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = typeof issue.path[0] === "string" ? issue.path[0] : "_form";
      fieldErrors[field] ??= issue.code === "unrecognized_keys" ? "That form contained a field we do not recognise." : issue.message;
    }
    return { ok: false, message: INVALID, fieldErrors };
  }
  const input = parsed.data;
  const spec = pricingKeys(input.projectType).find((k) => k.key === input.ruleKey);
  if (!spec) return { ok: false, message: "That rate does not exist for this project type." };
  if (spec.isTax && input.rate > MAX_TAX_PERCENT) {
    return { ok: false, message: INVALID, fieldErrors: { rate: `Enter a percentage from 0 to ${MAX_TAX_PERCENT}.` } };
  }

  const { data, error } = await supabase.from("pricing_rules").select("*").eq("project_type", input.projectType).limit(2000);
  if (error || !Array.isArray(data)) return { ok: false, message: NOT_SAVED };
  const rules = readRules(data);

  // The engine refuses a quote whose rules mix currencies, so a project type keeps one currency.
  const others = [...selectRules(rules, input.projectType, now).values()].filter((r) => r.rule_key !== input.ruleKey);
  const currencies = new Set(others.map((r) => r.currency));
  if (currencies.size > 0 && !currencies.has(input.currency)) {
    const current = [...currencies].sort().join(", ");
    return { ok: false, message: INVALID, fieldErrors: { currency: `Every rate for this project type uses ${current}. Use the same currency.` } };
  }

  const sameKey = rules.filter((r) => r.rule_key === input.ruleKey);
  const version = sameKey.reduce((max, r) => Math.max(max, r.version), 0) + 1;
  const inForce = selectRules(sameKey, input.projectType, now).get(input.ruleKey);

  const { data: inserted, error: insertError } = await supabase
    .from("pricing_rules")
    .insert({
      project_type: input.projectType,
      rule_key: input.ruleKey,
      rate: input.rate,
      unit: spec.isTax ? TAX_UNIT : input.unit,
      minimum_charge: spec.isTax ? 0 : input.minimumCharge,
      included_quantity: spec.isTax ? 0 : input.includedQuantity,
      // Not used by the quote engine; carried over so a new version changes only what was edited.
      add_on_rate: inForce?.add_on_rate ?? 0,
      currency: input.currency,
      effective_from: now.toISOString(),
      effective_until: null,
      version,
      is_active: true,
    })
    .select("id");
  if (insertError) {
    return { ok: false, message: (insertError as { code?: string }).code === "23505" ? CONFLICT : NOT_SAVED };
  }
  if (!Array.isArray(inserted) || inserted.length !== 1) return { ok: false, message: NOT_SAVED };
  return { ok: true, version };
}

// ---------------------------------------------------------------------------
// The administrator's overview
// ---------------------------------------------------------------------------

export type RuleInForce = { rate: number; unit: string; minimumCharge: number; includedQuantity: number; currency: string; version: number; effectiveFrom: string };

export type PricingRow = PricingKey & { current: RuleInForce | null; versions: number };

export type PricingTypeView = {
  type: ProjectType;
  /** The single currency in force, or null when nothing is priced yet or currencies are mixed. */
  currency: string | null;
  mixedCurrency: boolean;
  /** Keys a quote could need that have no rule in force. */
  missing: string[];
  rows: PricingRow[];
};

export type PricingOverview = { demoRates: boolean; types: PricingTypeView[] };

/** Everything the pricing screen shows, in two reads. Null when the rules cannot be read. */
export async function getPricingOverview(supabase: Client, now: Date = new Date()): Promise<PricingOverview | null> {
  const [rulesResult, modeResult] = await Promise.all([
    supabase.from("pricing_rules").select("*").limit(2000),
    supabase.from("site_settings").select("value_json").eq("key", "pricing_mode").maybeSingle(),
  ]);
  if (rulesResult.error || !Array.isArray(rulesResult.data)) return null;
  const rules = readRules(rulesResult.data);
  const mode = modeResult.data as { value_json?: { mode?: unknown } } | null;

  const types = PROJECT_TYPES.map((type): PricingTypeView => {
    const ofType = rules.filter((r) => r.project_type === type);
    const inForce = selectRules(ofType, type, now);
    const rows = pricingKeys(type).map((spec): PricingRow => {
      const rule = inForce.get(spec.key);
      return {
        ...spec,
        versions: ofType.filter((r) => r.rule_key === spec.key).length,
        current: rule
          ? { rate: rule.rate, unit: rule.unit, minimumCharge: rule.minimum_charge, includedQuantity: rule.included_quantity, currency: rule.currency, version: rule.version, effectiveFrom: rule.effective_from }
          : null,
      };
    });
    const currencies = new Set(rows.flatMap((r) => (r.current ? [r.current.currency] : [])));
    return {
      type,
      currency: currencies.size === 1 ? [...currencies][0] : null,
      mixedCurrency: currencies.size > 1,
      missing: rows.filter((r) => r.current === null).map((r) => r.label),
      rows,
    };
  });
  return { demoRates: mode?.value_json?.mode === "demo", types };
}
