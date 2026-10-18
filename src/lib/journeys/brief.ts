import { z } from "zod";
import type { ProjectType } from "@/lib/db/schema";
import { JOURNEY_STEPS, optionLabel, type FieldSpec } from "./steps";
import type { StepData } from "./validation";

/**
 * The structured English brief (06_IMPLEMENTATION_PLAN.md section 6.6, 03_APP_FLOW.md 3.4).
 *
 * Whatever produces a brief is UNTRUSTED: its output is parsed with BriefSchema before
 * it is stored or shown, and it can never decide what is missing, set a price or approve
 * anything. The server fills `missingRequiredFields` from its own validation.
 */

export const BRIEF_MAX_TEXT = 6000;

export const BriefSchema = z.strictObject({
  projectType: z.enum(["EMPTY_PLOT", "INTERIOR", "LANDSCAPE"]),
  sourceLanguage: z.string().min(2).max(16),
  requirements: z.record(z.string(), z.record(z.string(), z.unknown())),
  dimensionsAndUnits: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  roomOrZoneList: z.array(z.string().max(120)).max(40),
  stylePreferences: z.array(z.string().max(300)).max(20),
  budgetBand: z.string().max(40),
  referenceAssetIds: z.array(z.uuid()).max(50),
  missingRequiredFields: z.array(z.string().max(200)).max(60),
  /** Facts the customer did not give and the designer would otherwise have to guess. Optional to resolve. */
  missingOptionalDetails: z.array(z.string().max(200)).max(60),
  assumptions: z.array(z.string().max(300)).max(40),
  englishBrief: z.string().trim().min(1).max(BRIEF_MAX_TEXT),
  customerReadbackText: z.string().max(BRIEF_MAX_TEXT),
  imagePrompts: z.array(z.string().max(2000)).max(20),
  meta: z.strictObject({
    provider: z.enum(["mock", "openrouter"]),
    promptVersion: z.string().max(60),
    model: z.string().max(120).nullable(),
    generatedAt: z.iso.datetime(),
  }),
});

export type Brief = z.infer<typeof BriefSchema>;

export type BriefInput = {
  projectType: ProjectType;
  sourceLanguage: string;
  requirements: Record<string, StepData>;
};

/** A brief producer. Its result is unvalidated; callers must pass it through parseBrief. */
export interface BriefProvider {
  readonly id: "mock" | "openrouter";
  generate(input: BriefInput): Promise<unknown>;
}

export class BriefProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefProviderUnavailableError";
  }
}

export type BriefParseResult = { ok: true; brief: Brief } | { ok: false };

/** Rejects anything that is not exactly the expected shape. Never coerces. */
export function parseBrief(value: unknown): BriefParseResult {
  const parsed = BriefSchema.safeParse(value);
  return parsed.success ? { ok: true, brief: parsed.data } : { ok: false };
}

// ---------------------------------------------------------------------------
// Facts: the customer's own answers, worded for people
// ---------------------------------------------------------------------------

const DIMENSION_FIELDS = new Set(["plotWidth", "plotLength", "roomWidth", "roomLength"]);
const AREA_FIELDS = new Set(["builtUpArea"]);

function formatValue(field: FieldSpec, value: unknown, data: StepData): string {
  if (field.kind === "checkbox") return value ? "Yes" : "No";
  if (field.kind === "checkboxes") {
    const list = Array.isArray(value) ? value : [];
    return list.length ? list.map((v) => optionLabel(field, v)).join(", ") : "None";
  }
  if (field.kind === "number") {
    const unit = data.unit === "m" ? "m" : "ft";
    if (DIMENSION_FIELDS.has(field.name)) return `${value} ${unit}`;
    if (AREA_FIELDS.has(field.name)) return `${value} sq ${unit}`;
    if (field.name === "approxArea") return `${value} ${data.areaUnit === "sqm" ? "sq m" : "sq ft"}`;
  }
  if (field.kind === "select") return optionLabel(field, value);
  return String(value);
}

export type Fact = { stepTitle: string; label: string; value: string };

/** Every answered question, in form order. Unit selectors are folded into the values they qualify. */
export function describeAnswers(type: ProjectType, requirements: Record<string, StepData>): Fact[] {
  const facts: Fact[] = [];
  for (const step of JOURNEY_STEPS[type]) {
    const data = requirements[step.id];
    if (!data) continue;
    for (const field of step.fields) {
      if (field.name === "unit" || field.name === "areaUnit" || field.name === "text") continue;
      const value = data[field.name];
      if (value === undefined) continue;
      if (field.kind === "checkbox" && value === false) continue;
      if (field.kind === "checkboxes" && Array.isArray(value) && value.length === 0) continue;
      facts.push({ stepTitle: step.title, label: field.label, value: formatValue(field, value, data) });
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Deterministic mock provider (development and demo only)
// ---------------------------------------------------------------------------

export const MOCK_PROMPT_VERSION = "brief-mock-1";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

function selected(type: ProjectType, requirements: Record<string, StepData>, stepId: string, name: string): string[] {
  const step = JOURNEY_STEPS[type].find((s) => s.id === stepId);
  const field = step?.fields.find((f) => f.name === name);
  const value = requirements[stepId]?.[name];
  if (!field || !Array.isArray(value)) return [];
  return value.map((v) => optionLabel(field, v).toLowerCase());
}

function choice(type: ProjectType, requirements: Record<string, StepData>, stepId: string, name: string): string | null {
  const step = JOURNEY_STEPS[type].find((s) => s.id === stepId);
  const field = step?.fields.find((f) => f.name === name);
  const value = requirements[stepId]?.[name];
  if (!field || typeof value !== "string") return null;
  return optionLabel(field, value);
}

type Built = Pick<
  Brief,
  "dimensionsAndUnits" | "roomOrZoneList" | "stylePreferences" | "budgetBand" | "englishBrief" | "assumptions" | "missingOptionalDetails"
>;

function buildEmptyPlot(r: Record<string, StepData>): Built {
  const space = r.space ?? {};
  const rooms = r.rooms ?? {};
  const prefs = r.preferences ?? {};
  const unit = space.unit === "m" ? "m" : "ft";
  const extras = selected("EMPTY_PLOT", r, "rooms", "spaces");
  const style = choice("EMPTY_PLOT", r, "preferences", "style");
  const missing: string[] = [];
  if (space.orientation === undefined || space.orientation === "unknown") missing.push("Direction the plot faces");
  if (space.builtUpArea === undefined) missing.push("Built-up area");
  if (space.climate === undefined) missing.push("Climate notes");
  if (prefs.budgetBand === "undecided") missing.push("Budget band");
  missing.push("Reference photos or floor plan (uploads are not configured yet)");
  const sentences = [
    `A new ${plural(Number(space.floors), "floor")} home on an empty ${space.plotWidth} × ${space.plotLength} ${unit} plot in ${space.location}.`,
    `It needs ${plural(Number(rooms.bedrooms), "bedroom")}, ${plural(Number(rooms.bathrooms), "bathroom")} and ${plural(Number(rooms.parkingSpaces), "parking space")}${extras.length ? `, plus ${list(extras)}` : ""}.`,
    style && prefs.style !== "undecided" ? `The preferred style is ${style.toLowerCase()}.` : "No style has been chosen yet.",
    `Requested concept views: ${plural(Number(prefs.exteriorViews), "exterior view")} and ${plural(Number(prefs.interiorViews), "interior view")}${prefs.frontGarden ? ", with a front garden concept" : ""}.`,
  ];
  if (prefs.vastu === "yes") sentences.push("The customer would like Vastu followed where possible.");
  if (prefs.vastu === "no") sentences.push("The customer does not want Vastu applied.");
  return {
    dimensionsAndUnits: {
      plotWidth: Number(space.plotWidth),
      plotLength: Number(space.plotLength),
      unit,
      builtUpArea: typeof space.builtUpArea === "number" ? space.builtUpArea : null,
      floors: Number(space.floors),
    },
    roomOrZoneList: [
      plural(Number(rooms.bedrooms), "bedroom"),
      plural(Number(rooms.bathrooms), "bathroom"),
      ...extras,
    ],
    stylePreferences: style && prefs.style !== "undecided" ? [style] : [],
    budgetBand: String(prefs.budgetBand ?? "undecided"),
    englishBrief: sentences.join(" "),
    assumptions: [
      "Room sizes and positions will be proposed by the design concept and are not engineered.",
      "No local building rules, setbacks or approvals have been applied.",
      "The 2D layout is illustrative only and its dimensions are approximate.",
    ],
    missingOptionalDetails: missing,
  };
}

function buildInterior(r: Record<string, StepData>): Built {
  const space = r.space ?? {};
  const prefs = r.preferences ?? {};
  const keep = selected("INTERIOR", r, "preserve", "keep");
  const keepNotes = typeof r.preserve?.keepNotes === "string" ? r.preserve.keepNotes : null;
  const rooms = selected("INTERIOR", r, "space", "rooms");
  const style = choice("INTERIOR", r, "preferences", "style");
  const unit = space.unit === "m" ? "m" : "ft";
  const hasSize = typeof space.roomWidth === "number" && typeof space.roomLength === "number";
  const missing: string[] = [];
  if (!hasSize) missing.push("Approximate room dimensions");
  if (prefs.palette === undefined) missing.push("Colours and materials");
  if (prefs.budgetBand === "undecided") missing.push("Budget band");
  if (keep.length === 0 && !keepNotes) missing.push("Anything that must be kept in place");
  missing.push("Reference photos or floor plan (uploads are not configured yet)");
  const sentences = [
    `An interior refresh of ${plural(rooms.length, "room")}: ${list(rooms)}.`,
    hasSize ? `The approximate room size is ${space.roomWidth} × ${space.roomLength} ${unit}.` : "Room dimensions have not been given.",
    style && prefs.style !== "undecided" ? `The preferred style is ${style.toLowerCase()}.` : "No style has been chosen yet.",
    typeof prefs.palette === "string" ? `Colours and materials: ${prefs.palette}.` : "",
    typeof prefs.storageNeeds === "string" ? `Storage needs: ${prefs.storageNeeds}.` : "",
    `Requested concept views: ${plural(Number(prefs.viewsPerRoom), "view")} per room${prefs.materialSheet ? ", with a material and colour sheet" : ""}.`,
    keep.length ? `To be kept in place: ${list(keep)}.` : "",
    keepNotes ? `Details to preserve: ${keepNotes}` : "",
  ].filter(Boolean);
  return {
    dimensionsAndUnits: {
      roomWidth: typeof space.roomWidth === "number" ? space.roomWidth : null,
      roomLength: typeof space.roomLength === "number" ? space.roomLength : null,
      unit,
    },
    roomOrZoneList: rooms,
    stylePreferences: [
      ...(style && prefs.style !== "undecided" ? [style] : []),
      ...(typeof prefs.palette === "string" ? [prefs.palette] : []),
    ],
    budgetBand: String(prefs.budgetBand ?? "undecided"),
    englishBrief: sentences.join(" "),
    assumptions: [
      "Existing dimensions, structure, electrical and plumbing conditions have not been verified.",
      "Items marked to keep stay in place and the concepts work around them.",
    ],
    missingOptionalDetails: missing,
  };
}

function buildLandscape(r: Record<string, StepData>): Built {
  const area = r.area ?? {};
  const cond = r.conditions ?? {};
  const feat = r.features ?? {};
  const areaType = choice("LANDSCAPE", r, "area", "areaType") ?? "outdoor area";
  const sunlight = choice("LANDSCAPE", r, "conditions", "sunlight");
  const water = choice("LANDSCAPE", r, "conditions", "water");
  const maintenance = choice("LANDSCAPE", r, "conditions", "maintenance");
  const style = choice("LANDSCAPE", r, "features", "style");
  const unit = area.areaUnit === "sqm" ? "sq m" : "sq ft";
  const features: string[] = [];
  if (feat.paths) features.push("paths and hard surfaces");
  if (feat.seating) features.push("a place to sit");
  if (feat.privacy) features.push("privacy screening");
  if (feat.vegetableGarden) features.push("a vegetable or herb garden");
  const users = [cond.children ? "children" : "", cond.pets ? "pets" : ""].filter(Boolean);
  const missing: string[] = [];
  if (cond.climate === undefined) missing.push("Climate notes");
  if (cond.sunlight === "unsure") missing.push("Hours of direct sun");
  if (cond.water === "unsure") missing.push("Water availability");
  if (feat.retain === undefined) missing.push("Existing trees or features to keep");
  if (feat.budgetBand === "undecided") missing.push("Budget band");
  missing.push("Reference photos (uploads are not configured yet)");
  const sentences = [
    `A landscape design for a ${areaType.toLowerCase()} of about ${area.approxArea} ${unit} in ${cond.location}.`,
    `Sunlight: ${sunlight?.toLowerCase()}. Water: ${water?.toLowerCase()}. Upkeep wanted: ${maintenance?.toLowerCase()}.`,
    users.length ? `The space will be used by ${list(users)}.` : "",
    features.length ? `Features wanted: ${list(features)}.` : "",
    typeof feat.retain === "string" ? `To keep: ${feat.retain}` : "",
    style && feat.style !== "undecided" ? `The preferred style is ${style.toLowerCase()}.` : "No style has been chosen yet.",
    `Requested concept views: ${Number(feat.views)}.`,
  ].filter(Boolean);
  return {
    dimensionsAndUnits: { approxArea: Number(area.approxArea), unit },
    roomOrZoneList: [areaType, ...features],
    stylePreferences: style && feat.style !== "undecided" ? [style] : [],
    budgetBand: String(feat.budgetBand ?? "undecided"),
    englishBrief: sentences.join(" "),
    assumptions: [
      "Plant suggestions are general and need local and professional review for suitability.",
      "Drainage, irrigation and ground conditions have not been assessed.",
    ],
    missingOptionalDetails: missing,
  };
}

/**
 * Produces a brief from the answers alone, with no model. It is deterministic, never
 * invents a value the customer did not give, and is labelled as mock output in the
 * stored metadata so the interface can say so.
 */
export const mockBriefProvider: BriefProvider = {
  id: "mock",
  async generate(input) {
    const r = input.requirements;
    const built: Built =
      input.projectType === "EMPTY_PLOT" ? buildEmptyPlot(r) : input.projectType === "INTERIOR" ? buildInterior(r) : buildLandscape(r);
    const description = typeof r.description?.text === "string" ? r.description.text : null;
    const englishBrief = description ? `${built.englishBrief}\n\nCustomer notes: ${description}` : built.englishBrief;
    const missingOptionalDetails = description ? built.missingOptionalDetails : ["Your own description"].concat(built.missingOptionalDetails);
    const output: Brief = {
      projectType: input.projectType,
      sourceLanguage: input.sourceLanguage,
      requirements: r,
      dimensionsAndUnits: built.dimensionsAndUnits,
      roomOrZoneList: built.roomOrZoneList,
      stylePreferences: built.stylePreferences,
      budgetBand: built.budgetBand,
      referenceAssetIds: [],
      missingRequiredFields: [],
      missingOptionalDetails,
      assumptions: built.assumptions,
      englishBrief,
      customerReadbackText: built.englishBrief,
      imagePrompts: [],
      meta: { provider: "mock", promptVersion: MOCK_PROMPT_VERSION, model: null, generatedAt: new Date().toISOString() },
    };
    return output;
  },
};

/**
 * Chooses the provider. The live OpenRouter provider belongs to the AI phase, so until
 * then "live" mode reports unavailable instead of quietly falling back to the mock.
 */
export function getBriefProvider(mode: string | undefined): BriefProvider {
  if (mode === "live") {
    throw new BriefProviderUnavailableError("The live brief service is not available yet.");
  }
  return mockBriefProvider;
}
