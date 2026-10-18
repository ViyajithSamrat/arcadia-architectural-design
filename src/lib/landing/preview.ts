// Plain, deterministic sketch of a project for the landing-page preview.
// Nothing here talks to a server or a model, and nothing here prices anything:
// quotes are calculated on the server from the configured pricing rules.
// The sizes in this file only shape the preview drawing and are not a customer's brief.

export type ProjectType = "new-build" | "interior" | "landscape";

export type NewBuildStyle = "sloped" | "flat" | "courtyard";
export type InteriorStyle = "wood" | "plaster" | "terrazzo";
export type LandscapeStyle = "native" | "kitchen" | "shade";

export interface PlotSpec {
  type: ProjectType;
  widthFt: number;
  depthFt: number;
  floors: number;
  rooms: number;
  style: NewBuildStyle | InteriorStyle | LandscapeStyle;
  garden: boolean;
}

export interface Range {
  min: number;
  max: number;
  step: number;
}

export interface TypeConfig {
  label: string;
  widthLabel: string;
  depthLabel: string;
  width: Range;
  depth: Range;
  roomsLabel: string;
  rooms: Range;
  showFloors: boolean;
  gardenLabel: string;
  styles: { id: PlotSpec["style"]; label: string }[];
  example: string;
}

export const TYPE_CONFIG: Record<ProjectType, TypeConfig> = {
  "new-build": {
    label: "New build",
    widthLabel: "Plot width",
    depthLabel: "Plot depth",
    width: { min: 20, max: 80, step: 5 },
    depth: { min: 30, max: 100, step: 5 },
    roomsLabel: "Bedrooms",
    rooms: { min: 1, max: 6, step: 1 },
    showFloors: true,
    gardenLabel: "Keep space for a garden",
    styles: [
      { id: "sloped", label: "Sloped tiled roof" },
      { id: "flat", label: "Flat roof and terrace" },
      { id: "courtyard", label: "Open courtyard" },
    ],
    example: "A 30 by 40 plot, two floors, three bedrooms and a sloped tiled roof, with a small garden in front.",
  },
  interior: {
    label: "Interior",
    widthLabel: "Space width",
    depthLabel: "Space depth",
    width: { min: 10, max: 50, step: 1 },
    depth: { min: 10, max: 60, step: 1 },
    roomsLabel: "Rooms to refresh",
    rooms: { min: 1, max: 6, step: 1 },
    showFloors: false,
    gardenLabel: "Add indoor plants",
    styles: [
      { id: "wood", label: "Warm wood" },
      { id: "plaster", label: "Lime plaster" },
      { id: "terrazzo", label: "Terrazzo and brass" },
    ],
    example: "Refresh the living room and two bedrooms of a 24 by 36 flat in warm wood, with plants.",
  },
  landscape: {
    label: "Landscaping",
    widthLabel: "Garden width",
    depthLabel: "Garden depth",
    width: { min: 10, max: 80, step: 5 },
    depth: { min: 10, max: 100, step: 5 },
    roomsLabel: "Trees to plant or keep",
    rooms: { min: 0, max: 8, step: 1 },
    showFloors: false,
    gardenLabel: "Add a seating area",
    styles: [
      { id: "native", label: "Native, low water" },
      { id: "kitchen", label: "Kitchen garden" },
      { id: "shade", label: "Shaded courtyard" },
    ],
    example: "A 40 by 30 front garden with four shade trees, native plants that need little water and a place to sit.",
  },
};

export const DEFAULT_SPEC: Record<ProjectType, PlotSpec> = {
  "new-build": { type: "new-build", widthFt: 30, depthFt: 40, floors: 2, rooms: 3, style: "sloped", garden: true },
  interior: { type: "interior", widthFt: 24, depthFt: 36, floors: 1, rooms: 3, style: "wood", garden: true },
  landscape: { type: "landscape", widthFt: 40, depthFt: 30, floors: 1, rooms: 4, style: "native", garden: true },
};

const clamp = (n: number, r: Range) => Math.min(r.max, Math.max(r.min, n));

/** Clamp every field to the ranges allowed for its project type. */
export function normalise(spec: PlotSpec): PlotSpec {
  const cfg = TYPE_CONFIG[spec.type];
  const style = cfg.styles.some((s) => s.id === spec.style) ? spec.style : cfg.styles[0].id;
  return {
    ...spec,
    widthFt: clamp(Math.round(spec.widthFt), cfg.width),
    depthFt: clamp(Math.round(spec.depthFt), cfg.depth),
    floors: cfg.showFloors ? Math.min(3, Math.max(1, Math.round(spec.floors))) : 1,
    rooms: clamp(Math.round(spec.rooms), cfg.rooms),
    style,
  };
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, single: 1, two: 2, double: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
};

function toNumber(token: string): number | null {
  const n = Number(token);
  if (Number.isFinite(n)) return n;
  return WORD_NUMBERS[token.toLowerCase()] ?? null;
}

const NUM = "(\\d+|one|single|two|double|three|four|five|six|seven|eight)";

export interface ParseResult {
  spec: PlotSpec;
  understood: string[];
}

/**
 * Read a typed or spoken description and pull out the numbers we can trust.
 * Anything not recognised is left as it was; the caller shows what was understood.
 */
export function parseDescription(text: string, current: PlotSpec): ParseResult {
  const t = text.toLowerCase().slice(0, 600);
  const next: PlotSpec = { ...current };
  const understood: string[] = [];

  if (/\b(garden|landscap|lawn|yard)\b/.test(t) && !/\b(floor|storey|bedroom|bhk|house|build)\b/.test(t)) {
    next.type = "landscape";
  } else if (/\b(interior|refresh|redo|renovat|flat|apartment|living room)\b/.test(t) && !/\bplot\b/.test(t)) {
    next.type = "interior";
  } else if (/\b(plot|build|house|storey|floors?|bhk)\b/.test(t)) {
    next.type = "new-build";
  }
  if (next.type !== current.type) {
    Object.assign(next, { ...DEFAULT_SPEC[next.type] });
    understood.push(TYPE_CONFIG[next.type].label.toLowerCase());
  }

  const dims = t.match(/(\d{2,3})\s*(?:ft|feet|')?\s*(?:x|by|\*|×)\s*(\d{2,3})/);
  if (dims) {
    next.widthFt = Number(dims[1]);
    next.depthFt = Number(dims[2]);
    understood.push(`${dims[1]} × ${dims[2]} ft`);
  }

  const gPlus = t.match(/g\s*\+\s*(\d)/);
  const floorWords = t.match(new RegExp(`${NUM}[\\s-]*(?:floors?|storey|storeys|stories|story)`));
  if (gPlus) {
    next.floors = Number(gPlus[1]) + 1;
    understood.push(`G+${gPlus[1]}`);
  } else if (floorWords) {
    const n = toNumber(floorWords[1]);
    if (n) {
      next.floors = n;
      understood.push(`${n} floor${n > 1 ? "s" : ""}`);
    }
  }

  const roomWord =
    next.type === "landscape" ? "(?:trees?)" : next.type === "interior" ? "(?:rooms?|bedrooms?)" : "(?:bed(?:room)?s?|bhk)";
  const rooms = t.match(new RegExp(`${NUM}\\s*${roomWord}`));
  if (rooms) {
    const n = toNumber(rooms[1]);
    if (n !== null) {
      next.rooms = n;
      understood.push(`${n} ${next.type === "landscape" ? "trees" : next.type === "interior" ? "rooms" : "bedrooms"}`);
    }
  } else if (next.type === "interior") {
    const named = ["living", "bedroom", "kitchen", "dining", "study"].filter((r) => t.includes(r)).length;
    const extra = t.match(new RegExp(`(?:and|plus)\\s+${NUM}\\s+bedrooms?`));
    const count = named + (extra ? (toNumber(extra[1]) ?? 1) - 1 : 0);
    if (count > 0) {
      next.rooms = count;
      understood.push(`${count} rooms`);
    }
  }

  const styleRules: [RegExp, PlotSpec["style"], ProjectType][] = [
    [/sloped|tiled|kerala|mangalore|pitched/, "sloped", "new-build"],
    [/flat roof|terrace|modern|box/, "flat", "new-build"],
    [/courtyard|nadumuttam|aangan|angan/, "courtyard", "new-build"],
    [/wood|teak|timber/, "wood", "interior"],
    [/plaster|lime|white|minimal/, "plaster", "interior"],
    [/terrazzo|brass|marble/, "terrazzo", "interior"],
    [/native|low water|drought|less water|little water/, "native", "landscape"],
    [/kitchen garden|vegetable|herb/, "kitchen", "landscape"],
    [/shade|courtyard/, "shade", "landscape"],
  ];
  const style = styleRules.find(([re, , type]) => type === next.type && re.test(t));
  if (style) {
    next.style = style[1];
    understood.push(TYPE_CONFIG[next.type].styles.find((s) => s.id === style[1])!.label.toLowerCase());
  }

  const wantsExtra =
    next.type === "landscape" ? /seat|bench|sit/.test(t) : /garden|plant|green|lawn/.test(t);
  if (wantsExtra) {
    next.garden = true;
    understood.push(next.type === "landscape" ? "seating" : next.type === "interior" ? "plants" : "garden");
  }

  return { spec: normalise(next), understood };
}

const fmtInt = new Intl.NumberFormat("en-IN");
const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];
const word = (n: number) => NUMBER_WORDS[n] ?? String(n);

export const SETBACK = { side: 3, front: 5, rear: 3 } as const;

export function footprint(spec: PlotSpec) {
  if (spec.type !== "new-build") return { w: spec.widthFt, d: spec.depthFt };
  return {
    w: Math.max(10, spec.widthFt - SETBACK.side * 2),
    d: Math.max(12, spec.depthFt - SETBACK.front - SETBACK.rear - (spec.garden ? 6 : 0)),
  };
}

export interface Brief {
  summary: string;
  facts: string[];
  assumptions: string[];
  missing: string[];
}

export function buildBrief(spec: PlotSpec): Brief {
  const area = spec.widthFt * spec.depthFt;
  const styleLabel = TYPE_CONFIG[spec.type].styles.find((s) => s.id === spec.style)!.label.toLowerCase();

  if (spec.type === "new-build") {
    const fp = footprint(spec);
    const built = fp.w * fp.d * spec.floors;
    return {
      summary: `A ${word(spec.floors)}-storey home on a ${spec.widthFt} × ${spec.depthFt} ft plot, with ${word(spec.rooms)} bedroom${spec.rooms > 1 ? "s" : ""}, a kitchen, and living and dining space, finished with a ${styleLabel}${spec.garden ? " and a garden at the front" : ""}.`,
      facts: [
        `Plot: ${spec.widthFt} × ${spec.depthFt} ft (${fmtInt.format(area)} sq ft)`,
        `Floors: ${spec.floors}`,
        `Bedrooms: ${spec.rooms}`,
        `Style: ${styleLabel}`,
      ],
      assumptions: [
        `About ${fmtInt.format(built)} sq ft built across ${word(spec.floors)} floor${spec.floors > 1 ? "s" : ""}`,
        "One kitchen and at least one bathroom on each floor",
      ],
      missing: ["Which way the plot faces", "City or local building rules", "Budget band"],
    };
  }

  if (spec.type === "interior") {
    return {
      summary: `Refresh ${word(spec.rooms)} room${spec.rooms > 1 ? "s" : ""} in a ${spec.widthFt} × ${spec.depthFt} ft home in ${styleLabel}${spec.garden ? ", with indoor plants" : ""}, keeping doors, windows, columns and plumbing where they are.`,
      facts: [
        `Space: ${spec.widthFt} × ${spec.depthFt} ft (${fmtInt.format(area)} sq ft)`,
        `Rooms: ${spec.rooms}`,
        `Finish: ${styleLabel}`,
      ],
      assumptions: [
        "Walls, doors and windows stay where they are",
        "Existing electrical and plumbing points are reused",
      ],
      missing: ["Photos of each room", "Furniture you want to keep", "Budget band"],
    };
  }

  return {
    summary: `A ${spec.widthFt} × ${spec.depthFt} ft garden in a ${styleLabel} style, with ${word(spec.rooms)} tree${spec.rooms === 1 ? "" : "s"}${spec.garden ? " and a place to sit" : ""}.`,
    facts: [
      `Area: ${spec.widthFt} × ${spec.depthFt} ft (${fmtInt.format(area)} sq ft)`,
      `Trees: ${spec.rooms}`,
      `Style: ${styleLabel}`,
    ],
    assumptions: ["Ground is roughly level", "There is a water point nearby"],
    missing: ["Hours of direct sun", "Children or pets using the garden", "How much upkeep you want"],
  };
}
