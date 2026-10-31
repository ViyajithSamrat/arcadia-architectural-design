/**
 * Spending guard for the OpenRouter smoke tests. Two limits: the key itself must carry a credit
 * limit of at most US$5 (OpenRouter enforces it), and one smoke pass may spend at most
 * SMOKE_PASS_BUDGET_USD (US$0.50, the owner's ceiling for a pass), retries included. Pure functions over the two documented read-only responses, so the rules are unit
 * tested without a network:
 *
 *   GET https://openrouter.ai/api/v1/models   (public) - modalities, supported parameters, price
 *   GET https://openrouter.ai/api/v1/key      (Bearer key) - the key's own credit limit and usage
 *
 * The strongest limit OpenRouter offers is the credit limit on the key itself, which OpenRouter
 * enforces. So the guard REQUIRES a key whose own limit is at most the budget, and does not rely on
 * an estimate. Prices are used only to refuse a model whose price is unknown or absurd, and the
 * real spend is read back from the key's usage counter after every call.
 */

/** The most the API key's own credit limit may be. */
export const SMOKE_BUDGET_USD = 5;
/** The most one smoke pass may spend, measured from the key's usage counter. */
export const SMOKE_PASS_BUDGET_USD = 0.5;
/** No single smoke request may be priced above this by the model's published price. */
export const SMOKE_MAX_PER_REQUEST_USD = 0.25;
/** Output tokens one image can cost at most, for models priced per image token. A deliberately generous bound. */
export const IMAGE_TOKENS_UPPER_BOUND = 8000;
export const TEXT_TOKENS_UPPER_BOUND = 4000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const price = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null; // OpenRouter uses "-1" for variable pricing: treated as unknown
};

export type Check = { ok: true; notes: string[] } | { ok: false; reasons: string[] };
const result = (reasons: string[], notes: string[] = []): Check => (reasons.length ? { ok: false, reasons } : { ok: true, notes });

/** The key's own limit must exist, be at most the budget, and have something left. */
export function assessKey(response: unknown, budgetUsd = SMOKE_BUDGET_USD): Check & { usage?: number } {
  const data = obj(obj(response)?.data);
  if (!data) return { ...result(["the key information could not be read"]) };
  const reasons: string[] = [];
  const limit = typeof data.limit === "number" ? data.limit : null;
  const remaining = typeof data.limit_remaining === "number" ? data.limit_remaining : null;
  const usage = typeof data.usage === "number" ? data.usage : null;
  if (limit === null) reasons.push("the key has no credit limit of its own; create a key with a limit of at most US$" + budgetUsd);
  else if (limit > budgetUsd) reasons.push(`the key's limit (US$${limit}) is above the smoke-test budget (US$${budgetUsd})`);
  if (remaining === null || remaining <= 0) reasons.push("the key has no credit left");
  if (usage === null) reasons.push("the key's usage could not be read");
  return { ...result(reasons, [`limit US$${limit}, remaining US$${remaining}`]), usage: usage ?? undefined };
}

type Kind = "text" | "image";

/** Worst-case price of one request to this model, or null when the published price is not usable. */
export function worstCaseRequestUsd(model: Json, kind: Kind): number | null {
  const p = obj(model.pricing);
  if (!p) return null;
  if (kind === "image") {
    const perImage = price(p.image);
    const perToken = price(p.image_output);
    const prompt = price(p.prompt) ?? 0;
    const candidates = [perImage, perToken === null ? null : perToken * IMAGE_TOKENS_UPPER_BOUND].filter((x): x is number => x !== null);
    if (candidates.length === 0) return null;
    return Math.max(...candidates) + prompt * 2000;
  }
  const prompt = price(p.prompt);
  const completion = price(p.completion);
  if (prompt === null || completion === null) return null;
  return prompt * 4000 + completion * TEXT_TOKENS_UPPER_BOUND;
}

/** The model exists, can produce what the adapter asks for, and has a usable, small enough price. */
export function assessModel(listResponse: unknown, modelId: string, kind: Kind, maxPerRequestUsd = SMOKE_MAX_PER_REQUEST_USD): Check & { worstCaseUsd?: number } {
  const list = obj(listResponse)?.data;
  if (!Array.isArray(list)) return { ...result(["the model list could not be read"]) };
  const model = list.map(obj).find((m) => m && m.id === modelId);
  if (!model) return { ...result([`model ${modelId} is not in OpenRouter's list`]) };
  const reasons: string[] = [];
  const arch = obj(model.architecture);
  const outputs = Array.isArray(arch?.output_modalities) ? (arch!.output_modalities as unknown[]) : [];
  if (kind === "image" && !outputs.includes("image")) reasons.push("the model does not list image as an output");
  if (kind === "text") {
    if (!outputs.includes("text")) reasons.push("the model does not list text as an output");
    const params = Array.isArray(model.supported_parameters) ? (model.supported_parameters as unknown[]) : [];
    if (!params.includes("structured_outputs") && !params.includes("response_format")) reasons.push("the model does not list structured outputs (the brief adapter requires a JSON schema)");
  }
  const worst = worstCaseRequestUsd(model, kind);
  if (worst === null) reasons.push("the model's price is not published in a usable form");
  else if (worst > maxPerRequestUsd) reasons.push(`the worst-case price of one request (US$${worst.toFixed(4)}) is above the per-request limit (US$${maxPerRequestUsd})`);
  return { ...result(reasons, [worst === null ? "price unknown" : `worst case US$${worst.toFixed(4)} per request`]), worstCaseUsd: worst ?? undefined };
}

/** Real spend since the guard started, from the key's usage counter. */
export class SpendGuard {
  constructor(
    private readonly startUsage: number,
    private readonly budgetUsd = SMOKE_PASS_BUDGET_USD,
  ) {}
  spent(currentUsage: number): number {
    return Math.max(0, currentUsage - this.startUsage);
  }
  /** A further paid request is allowed only if the spend so far plus its worst case still fits the budget. */
  mayContinue(currentUsage: number, nextWorstCaseUsd: number): boolean {
    return Number.isFinite(nextWorstCaseUsd) && this.spent(currentUsage) + nextWorstCaseUsd <= this.budgetUsd;
  }
}
