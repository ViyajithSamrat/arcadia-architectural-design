import { z } from "zod";
import type { ProjectType } from "@/lib/db/schema";
import { JOURNEY_STEPS, optionLabel, type FieldSpec } from "@/lib/journeys/steps";
import { validateRequirements, type StepData } from "@/lib/journeys/validation";

/**
 * The empty-plot layout sketch (13_ARCHITECTURE_DECISION.md, 06_IMPLEMENTATION_PLAN.md section 6.7):
 * a deterministic SVG drawn by this code from the customer's validated answers, never by an
 * image model.
 *
 * Nothing is stored. The sketch is drawn again whenever a screen shows it, from the project's
 * saved answers, which can no longer change once the quote is accepted. The same answers and
 * the same FLOOR_PLAN_VERSION always give byte-identical SVG.
 *
 * Only some of it is grounded in what the customer said: the plot outline in their proportions,
 * the plot dimensions and unit they entered, the number of floors, the facing direction, and one
 * block per requested room or space. Everything else (margins, the parking strip, block sizes,
 * which floor a room is on) is a fixed drawing rule and is listed as an assumption. No room size
 * is shown, because none was given.
 *
 * Coordinates are SVG user units in a fixed FLOOR_PLAN_WIDTH x FLOOR_PLAN_HEIGHT view box,
 * origin top left, x to the right, y down. The plot width runs along x with the front edge drawn
 * at the bottom, and the plot length along y, at one scale for both axes. A plot more elongated
 * than MAX_DRAWN_RATIO is drawn at that ratio and marked "Not to scale" so its labels stay
 * readable.
 *
 * The SVG contains only svg, title, rect and text elements with numeric or fixed attributes, and
 * every piece of text is escaped. It has no script, event handler, link, style sheet, embedded
 * image or external reference.
 */

export const FLOOR_PLAN_VERSION = "plan-svg-1";
export const FLOOR_PLAN_WIDTH = 720;
export const FLOOR_PLAN_HEIGHT = 540;
export const FLOOR_PLAN_DISCLAIMER = "Illustrative layout only — not CAD or a construction drawing.";
/** Plots more elongated than this (width to length either way) are drawn at this ratio, not to scale. */
export const MAX_DRAWN_RATIO = 3;
/** Far above the largest sketch the form allows; anything bigger is refused rather than shown. */
export const MAX_SVG_CHARS = 32_000;

const PAD = { left: 64, right: 24, top: 64, bottom: 76 } as const;
const AREA_W = FLOOR_PLAN_WIDTH - PAD.left - PAD.right;
const AREA_H = FLOOR_PLAN_HEIGHT - PAD.top - PAD.bottom;
/** Open margin on each side of the building zone, as a share of the drawn plot. */
const MARGIN_SHARE = 0.06;
/** Depth of the parking strip along the front, as a share of the drawn plot length. */
const PARKING_SHARE = 0.18;

// ---------------------------------------------------------------------------
// Input: the empty-plot answers, checked again against the journey's own bounds
// ---------------------------------------------------------------------------

const EMPTY_PLOT_STEPS = JOURNEY_STEPS.EMPTY_PLOT;

function journeyField(stepId: string, name: string): FieldSpec {
  const field = EMPTY_PLOT_STEPS.find((s) => s.id === stepId)?.fields.find((f) => f.name === name);
  if (!field) throw new Error(`floor plan: the empty-plot journey has no ${stepId}.${name} question`);
  return field;
}

/** The same bounds the form and the server save use, so the three cannot disagree. */
function boundedNumber(stepId: string, name: string) {
  const field = journeyField(stepId, name);
  if (field.kind !== "number") throw new Error(`floor plan: ${stepId}.${name} is not a number question`);
  const n = z.number().refine(Number.isFinite).min(field.min).max(field.max);
  return field.integer ? n.int() : n;
}

function optionValues(stepId: string, name: string): [string, ...string[]] {
  const field = journeyField(stepId, name);
  if (field.kind !== "select" && field.kind !== "checkboxes") throw new Error(`floor plan: ${stepId}.${name} has no options`);
  return field.options.map((o) => o.value) as [string, ...string[]];
}

const SPACES_FIELD = journeyField("rooms", "spaces");
const ORIENTATION_FIELD = journeyField("space", "orientation");
const SPACE_VALUES = optionValues("rooms", "spaces");

export const PlanInputSchema = z.strictObject({
  plotWidth: boundedNumber("space", "plotWidth"),
  plotLength: boundedNumber("space", "plotLength"),
  unit: z.enum(optionValues("space", "unit")),
  orientation: z.enum(optionValues("space", "orientation")).optional(),
  floors: boundedNumber("space", "floors"),
  bedrooms: boundedNumber("rooms", "bedrooms"),
  bathrooms: boundedNumber("rooms", "bathrooms"),
  parkingSpaces: boundedNumber("rooms", "parkingSpaces"),
  spaces: z.array(z.enum(SPACE_VALUES)).max(SPACE_VALUES.length * 2),
});

export type PlanInput = z.infer<typeof PlanInputSchema>;

export type PlanInputResult = { ok: true; input: PlanInput } | { ok: false };

/** Validates and normalises: spaces become unique and in form order, so equal answers give equal input. */
export function parsePlanInput(value: unknown): PlanInputResult {
  const parsed = PlanInputSchema.safeParse(value);
  if (!parsed.success) return { ok: false };
  const spaces = SPACE_VALUES.filter((v) => parsed.data.spaces.includes(v));
  return { ok: true, input: { ...parsed.data, spaces } };
}

/** Picks the layout's answers out of validated empty-plot requirements. */
export function planInputFromRequirements(requirements: Record<string, StepData>): PlanInputResult {
  const space = requirements.space ?? {};
  const rooms = requirements.rooms ?? {};
  return parsePlanInput({
    plotWidth: space.plotWidth,
    plotLength: space.plotLength,
    unit: space.unit,
    orientation: space.orientation,
    floors: space.floors,
    bedrooms: rooms.bedrooms,
    bathrooms: rooms.bathrooms,
    parkingSpaces: rooms.parkingSpaces,
    spaces: rooms.spaces ?? [],
  });
}

// ---------------------------------------------------------------------------
// Layout: a fixed rule, no randomness
// ---------------------------------------------------------------------------

export type Rect = { x: number; y: number; width: number; height: number };
export type PlanRoom = Rect & { number: number; label: string };
export type PlanFloor = { name: string; parking: (Rect & { spaces: number }) | null; rooms: PlanRoom[] };

export type PlanLayout = {
  version: string;
  unit: string;
  plotWidth: number;
  plotLength: number;
  /** The direction the front edge faces, in words; null when the customer did not say. */
  facing: string | null;
  notToScale: boolean;
  plot: Rect;
  /** The building zone, the same on every floor. */
  zone: Rect;
  floors: PlanFloor[];
  assumptions: string[];
};

type Block = { label: string; weight: number };

/** Relative block sizes: a drawing rule only, not room areas. */
const WEIGHTS: Readonly<Record<string, number>> = {
  living: 4,
  dining: 2,
  kitchen: 2,
  puja: 1,
  study: 2,
  utility: 1,
  storage: 1,
  stairs: 1,
  balcony: 1,
  bedroom: 3,
  bathroom: 1,
  open: 3,
};

/** Shared rooms, kept on the ground floor. */
const GROUND_SPACES = ["living", "dining", "kitchen", "puja", "study", "utility", "storage"] as const;

const FLOOR_NAMES = ["Ground floor", "First floor", "Second floor", "Third floor"];

const spaceBlock = (value: string): Block => ({ label: optionLabel(SPACES_FIELD, value), weight: WEIGHTS[value] ?? 1 });

/** Which blocks go on which floor. Upper floors take bedrooms and bathrooms first, in turn. */
function allocate(input: PlanInput): { floors: Block[][]; addedStairs: boolean } {
  const count = input.floors;
  const floors: Block[][] = Array.from({ length: count }, () => []);
  for (const value of GROUND_SPACES) if (input.spaces.includes(value)) floors[0].push(spaceBlock(value));

  const addedStairs = count > 1 && !input.spaces.includes("stairs");
  if (count > 1 || input.spaces.includes("stairs")) for (const floor of floors) floor.push(spaceBlock("stairs"));

  const turn = count === 1 ? [0] : [...Array.from({ length: count - 1 }, (_, i) => i + 1), 0];
  for (let i = 0; i < input.bedrooms; i += 1) floors[turn[i % turn.length]].push({ label: `Bedroom ${i + 1}`, weight: WEIGHTS.bedroom });
  for (let i = 0; i < input.bathrooms; i += 1) floors[turn[i % turn.length]].push({ label: `Bathroom ${i + 1}`, weight: WEIGHTS.bathroom });

  if (input.spaces.includes("balcony")) {
    if (count === 1) floors[0].push(spaceBlock("balcony"));
    else for (let f = 1; f < count; f += 1) floors[f].push(spaceBlock("balcony"));
  }

  const circulation = new Set([spaceBlock("stairs").label, spaceBlock("balcony").label]);
  for (const floor of floors) {
    if (floor.every((b) => circulation.has(b.label))) floor.push({ label: "Open space (not allocated)", weight: WEIGHTS.open });
  }
  return { floors, addedStairs };
}

/** Rows of blocks filling the zone exactly; the last block of each row and the last row take the remainder. */
function pack(blocks: Block[], zone: Rect, firstNumber: number): PlanRoom[] {
  const n = blocks.length;
  const rows = Math.min(n, Math.max(1, Math.round(Math.sqrt((n * zone.height) / zone.width))));
  const total = blocks.reduce((s, b) => s + b.weight, 0);
  const rooms: PlanRoom[] = [];
  let next = 0;
  let y = zone.y;
  for (let r = 0; r < rows; r += 1) {
    const size = Math.floor(n / rows) + (r < n % rows ? 1 : 0);
    const row = blocks.slice(next, next + size);
    next += size;
    const rowWeight = row.reduce((s, b) => s + b.weight, 0);
    const height = r === rows - 1 ? zone.y + zone.height - y : (zone.height * rowWeight) / total;
    let x = zone.x;
    row.forEach((block, k) => {
      const width = k === row.length - 1 ? zone.x + zone.width - x : (zone.width * block.weight) / rowWeight;
      rooms.push({ x, y, width, height, number: firstNumber + rooms.length, label: block.label });
      x += width;
    });
    y += height;
  }
  return rooms;
}

export function layoutFloorPlan(input: PlanInput): PlanLayout {
  const ratio = input.plotWidth / input.plotLength;
  const drawnRatio = Math.min(MAX_DRAWN_RATIO, Math.max(1 / MAX_DRAWN_RATIO, ratio));
  const notToScale = drawnRatio !== ratio;

  let width = AREA_W;
  let height = AREA_W / drawnRatio;
  if (height > AREA_H) {
    height = AREA_H;
    width = AREA_H * drawnRatio;
  }
  const plot: Rect = { x: PAD.left + (AREA_W - width) / 2, y: PAD.top + (AREA_H - height) / 2, width, height };
  const mx = width * MARGIN_SHARE;
  const my = height * MARGIN_SHARE;
  const parkingDepth = input.parkingSpaces > 0 ? height * PARKING_SHARE : 0;
  const zone: Rect = { x: plot.x + mx, y: plot.y + my, width: width - 2 * mx, height: height - 2 * my - parkingDepth };
  const parking = input.parkingSpaces > 0 ? { x: zone.x, y: zone.y + zone.height, width: zone.width, height: parkingDepth, spaces: input.parkingSpaces } : null;

  const { floors: blocks, addedStairs } = allocate(input);
  let number = 1;
  const floors: PlanFloor[] = blocks.map((floorBlocks, i) => {
    const rooms = pack(floorBlocks, zone, number);
    number += rooms.length;
    return { name: FLOOR_NAMES[i], parking: i === 0 ? parking : null, rooms };
  });

  const facing = input.orientation && input.orientation !== "unknown" ? optionLabel(ORIENTATION_FIELD, input.orientation) : null;
  const assumptions = [
    "The front of the plot is drawn at the bottom, with the plot width along it.",
    "Each block stands for a requested room or space. Block sizes and positions follow a fixed drawing rule; no room sizes were given and none are implied.",
    "The open margins and the parking strip are drawn for clarity only. No setbacks, building rules or approvals have been applied.",
    ...(input.floors > 1 ? ["Shared rooms are placed on the ground floor and bedrooms and bathrooms are spread across the floors by a fixed rule."] : []),
    ...(addedStairs ? ["A staircase is shown on every floor because the home has more than one floor."] : []),
    ...(notToScale ? [`The plot is more elongated than 1:${MAX_DRAWN_RATIO}, so it is drawn wider or shorter than it really is. Not to scale.`] : []),
    ...(facing ? [] : ["The direction the plot faces was not given."]),
  ];

  return { version: FLOOR_PLAN_VERSION, unit: input.unit, plotWidth: input.plotWidth, plotLength: input.plotLength, facing, notToScale, plot, zone, floors, assumptions };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** Escapes text for XML content and attribute values, and drops characters XML cannot carry. */
export function escapeXml(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0xfffe || code === 0xffff) continue;
    out += ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : ch === "'" ? "&apos;" : ch;
  }
  return out;
}

/** Fixed one-decimal coordinates, so equal layouts print identically. */
const num = (value: number) => (Math.round(value * 10) / 10).toFixed(1);

/** A measurement as the customer typed it, without floating-point noise. */
const measure = (value: number) => String(Number(value.toFixed(2)));

/** Rough text width for a sans-serif font, used only to decide whether a label fits. */
const CHAR_EM = 0.6;

function fit(text: string, box: Rect): number | null {
  for (const size of [13, 11, 9]) {
    if (text.length * size * CHAR_EM <= box.width - 6 && size + 4 <= box.height) return size;
  }
  return null;
}

function text(x: number, y: number, size: number, content: string, extra = ""): string {
  return `<text x="${num(x)}" y="${num(y)}" font-size="${size}"${extra}>${escapeXml(content)}</text>`;
}

/** A label centred in a box, or nothing when even the short form would not fit. */
function boxLabel(box: Rect, full: string, short: string): string {
  for (const candidate of [full, short]) {
    const size = fit(candidate, box);
    if (size !== null) return text(box.x + box.width / 2, box.y + box.height / 2 + size * 0.35, size, candidate, ' text-anchor="middle"');
  }
  return "";
}

export function renderFloorPlanSvg(layout: PlanLayout, floorIndex: number): string {
  const floor = layout.floors[floorIndex];
  if (!floor) throw new RangeError(`floor plan: there is no floor ${floorIndex}`);
  const { plot, zone } = layout;
  const upper = floorIndex > 0;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FLOOR_PLAN_WIDTH} ${FLOOR_PLAN_HEIGHT}" width="${FLOOR_PLAN_WIDTH}" height="${FLOOR_PLAN_HEIGHT}" font-family="system-ui, sans-serif" fill="#1f2937">`,
    `<title>${escapeXml(`${floor.name}: illustrative layout sketch`)}</title>`,
    `<rect x="0" y="0" width="${FLOOR_PLAN_WIDTH}" height="${FLOOR_PLAN_HEIGHT}" fill="#ffffff"/>`,
    text(PAD.left, 30, 18, `${floor.name} — illustrative layout`, ' font-weight="600"'),
    text(PAD.left, 50, 12, layout.facing ? `Front edge (bottom) faces ${layout.facing}` : "Facing direction not given", ' fill="#4b5563"'),
    `<rect x="${num(plot.x)}" y="${num(plot.y)}" width="${num(plot.width)}" height="${num(plot.height)}" fill="${upper ? "none" : "#f5f1e8"}" stroke="#374151" stroke-width="2"${upper ? ' stroke-dasharray="6 4"' : ""}/>`,
  ];

  if (floor.parking) {
    const p = floor.parking;
    parts.push(`<rect x="${num(p.x)}" y="${num(p.y)}" width="${num(p.width)}" height="${num(p.height)}" fill="#e5e7eb" stroke="#6b7280" stroke-dasharray="4 3"/>`);
    parts.push(boxLabel(p, `Parking (${p.spaces} ${p.spaces === 1 ? "space" : "spaces"})`, "P"));
  }

  parts.push(`<rect x="${num(zone.x)}" y="${num(zone.y)}" width="${num(zone.width)}" height="${num(zone.height)}" fill="#ffffff" stroke="#111827" stroke-width="2"/>`);
  for (const room of floor.rooms) {
    parts.push(`<rect x="${num(room.x)}" y="${num(room.y)}" width="${num(room.width)}" height="${num(room.height)}" fill="#ffffff" stroke="#4b5563"/>`);
    parts.push(boxLabel(room, `${room.number}. ${room.label}`, String(room.number)));
  }

  const midX = plot.x + plot.width / 2;
  const midY = plot.y + plot.height / 2;
  parts.push(text(midX, plot.y + plot.height + 20, 12, `Plot width ${measure(layout.plotWidth)} ${layout.unit}`, ' text-anchor="middle"'));
  parts.push(text(plot.x - 14, midY, 12, `Plot length ${measure(layout.plotLength)} ${layout.unit}`, ` text-anchor="middle" transform="rotate(-90 ${num(plot.x - 14)} ${num(midY)})"`));
  parts.push(text(PAD.left, FLOOR_PLAN_HEIGHT - 32, 12, FLOOR_PLAN_DISCLAIMER, ' font-weight="600"'));
  parts.push(
    text(
      PAD.left,
      FLOOR_PLAN_HEIGHT - 14,
      11,
      `Drawn by the app from the project answers, not by an AI model · ${layout.version}${layout.notToScale ? " · Not to scale" : ""}`,
      ' fill="#4b5563"',
    ),
  );
  parts.push("</svg>");
  return parts.filter(Boolean).join("");
}

export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// ---------------------------------------------------------------------------
// What a screen receives
// ---------------------------------------------------------------------------

export type FloorPlanView =
  | {
      state: "ready";
      version: string;
      disclaimer: string;
      notToScale: boolean;
      assumptions: string[];
      floors: { name: string; dataUrl: string; width: number; height: number }[];
      rooms: { number: number; label: string; floor: string }[];
    }
  /** The saved answers could not be turned into a sketch. Nothing else is said about them. */
  | { state: "unavailable" };

/**
 * The sketch for a project, drawn from its stored answers after checking them again. Null for
 * project types that have no layout sketch. Callers decide WHO may see it and WHEN (the
 * generation read layer applies the same rules as for generated images).
 */
export function describeFloorPlan(projectType: ProjectType, requirementsJson: unknown): FloorPlanView | null {
  if (projectType !== "EMPTY_PLOT") return null;
  const check = validateRequirements("EMPTY_PLOT", requirementsJson);
  if (!check.complete) return { state: "unavailable" };
  const parsed = planInputFromRequirements(check.requirements);
  if (!parsed.ok) return { state: "unavailable" };
  try {
    const layout = layoutFloorPlan(parsed.input);
    const svgs = layout.floors.map((_, i) => renderFloorPlanSvg(layout, i));
    if (svgs.some((svg) => svg.length > MAX_SVG_CHARS)) return { state: "unavailable" };
    return {
      state: "ready",
      version: layout.version,
      disclaimer: FLOOR_PLAN_DISCLAIMER,
      notToScale: layout.notToScale,
      assumptions: layout.assumptions,
      floors: layout.floors.map((floor, i) => ({ name: floor.name, dataUrl: svgDataUrl(svgs[i]), width: FLOOR_PLAN_WIDTH, height: FLOOR_PLAN_HEIGHT })),
      rooms: layout.floors.flatMap((floor) => floor.rooms.map((room) => ({ number: room.number, label: room.label, floor: floor.name }))),
    };
  } catch {
    return { state: "unavailable" };
  }
}
