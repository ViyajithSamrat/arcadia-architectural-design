import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFloorPlanDxf, dxfText } from "@/lib/generation/dxf";
import { FLOOR_PLAN_DISCLAIMER, layoutFloorPlan, layoutFromRequirements, parsePlanInput, renderFloorPlanSvg, type PlanLayout } from "@/lib/generation/floor-plan";
import { REQUIREMENTS, storedRequirements } from "./support/journey-fixtures";

/**
 * The DXF is checked by reading it back with an independent, deliberately small DXF reader (below) and
 * comparing what it finds with the layout it was written from. Nothing here looks at filenames or
 * status codes: the content and the geometry are the subject.
 */

type Entity = { type: string; layer: string; codes: Map<number, string[]>; vertices: [number, number][] };

function readPairs(text: string): [number, string][] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  expect(lines.length % 2).toBe(0);
  const pairs: [number, string][] = [];
  for (let i = 0; i < lines.length; i += 2) {
    expect(lines[i].trim()).toMatch(/^-?\d+$/); // every group code is an integer
    pairs.push([Number(lines[i]), lines[i + 1]]);
  }
  return pairs;
}

/** Splits the file into its sections and reads the entities (POLYLINE/VERTEX/SEQEND folded into one polyline). */
function parse(text: string) {
  const pairs = readPairs(text);
  expect(pairs[pairs.length - 1]).toEqual([0, "EOF"]);
  const sections = new Map<string, [number, string][]>();
  for (let i = 0; i < pairs.length - 1; ) {
    expect(pairs[i]).toEqual([0, "SECTION"]);
    const name = pairs[i + 1][1];
    let j = i + 2;
    while (!(pairs[j][0] === 0 && pairs[j][1] === "ENDSEC")) j += 1;
    sections.set(name, pairs.slice(i + 2, j));
    i = j + 1;
  }
  const header = new Map<string, string[]>();
  let key = "";
  for (const [code, value] of sections.get("HEADER") ?? []) {
    if (code === 9) {
      key = value;
      header.set(key, []);
    } else header.get(key)!.push(value);
  }
  const entities: Entity[] = [];
  let current: Entity | null = null;
  let polyline: Entity | null = null;
  for (const [code, value] of sections.get("ENTITIES") ?? []) {
    if (code === 0) {
      if (value === "VERTEX") {
        current = { type: "VERTEX", layer: "", codes: new Map(), vertices: [] };
      } else if (value === "SEQEND") {
        polyline = null;
        current = null;
      } else {
        current = { type: value, layer: "", codes: new Map(), vertices: [] };
        entities.push(current);
        if (value === "POLYLINE") polyline = current;
      }
    } else if (current) {
      if (code === 8) current.layer = value;
      const list = current.codes.get(code) ?? [];
      list.push(value);
      current.codes.set(code, list);
      if (current.type === "VERTEX" && code === 20 && polyline) polyline.vertices.push([Number(current.codes.get(10)![0]), Number(value)]);
    }
  }
  const layerTable = (sections.get("TABLES") ?? []).filter(([c], i, all) => c === 2 && all[i - 1]?.[1] === "LAYER" && all[i - 1][0] === 0).map(([, v]) => v);
  return { sections, header, entities, layerTable };
}

const bbox = (vertices: [number, number][]) => ({
  minX: Math.min(...vertices.map((v) => v[0])),
  maxX: Math.max(...vertices.map((v) => v[0])),
  minY: Math.min(...vertices.map((v) => v[1])),
  maxY: Math.max(...vertices.map((v) => v[1])),
});
const area = (v: [number, number][]) => {
  const b = bbox(v);
  return (b.maxX - b.minX) * (b.maxY - b.minY);
};
const polylines = (e: Entity[], layer: string) => e.filter((x) => x.type === "POLYLINE" && x.layer === layer);
const texts = (e: Entity[], layer?: string) => e.filter((x) => x.type === "TEXT" && (!layer || x.layer === layer)).map((x) => x.codes.get(1)![0]);

function layoutOf(over: Record<string, unknown> = {}): PlanLayout {
  const base = { plotWidth: 30, plotLength: 40, unit: "ft", orientation: "E", floors: 2, bedrooms: 3, bathrooms: 2, parkingSpaces: 1, spaces: ["living", "kitchen", "stairs"], ...over };
  const parsed = parsePlanInput(base);
  if (!parsed.ok) throw new Error("bad test input");
  return layoutFloorPlan(parsed.input);
}
const build = (layout: PlanLayout) => {
  const out = buildFloorPlanDxf(layout);
  if (!out.ok) throw new Error(`dxf failed: ${out.reason}`);
  return out;
};

describe("the DXF file", () => {
  const layout = layoutFromRequirements("EMPTY_PLOT", storedRequirements("EMPTY_PLOT"))!;
  const out = build(layout);
  const dxf = parse(out.content);

  it("is a well-formed R12 DXF: integer group codes, the five sections in order, ends with EOF", () => {
    expect(layout).not.toBeNull();
    expect([...dxf.sections.keys()]).toEqual(["HEADER", "TABLES", "BLOCKS", "ENTITIES"]);
    expect(dxf.header.get("$ACADVER")).toEqual(["AC1009"]);
    expect(out.content.endsWith("0\r\nEOF\r\n")).toBe(true);
  });

  it("declares its unit and drawing extents; the extents contain every vertex", () => {
    expect(dxf.header.get("$INSUNITS")).toEqual(["2"]); // feet
    expect(dxf.header.get("$MEASUREMENT")).toEqual(["0"]);
    const min = dxf.header.get("$EXTMIN")!.map(Number);
    const max = dxf.header.get("$EXTMAX")!.map(Number);
    for (const e of dxf.entities.filter((x) => x.type === "POLYLINE")) {
      const b = bbox(e.vertices);
      expect(b.minX).toBeGreaterThanOrEqual(min[0] - 1e-6);
      expect(b.maxX).toBeLessThanOrEqual(max[0] + 1e-6);
      expect(b.minY).toBeGreaterThanOrEqual(min[1] - 1e-6);
      expect(b.maxY).toBeLessThanOrEqual(max[1] + 1e-6);
    }
  });

  it("uses metres when the customer did", () => {
    const m = parse(build(layoutOf({ unit: "m", plotWidth: 12, plotLength: 18 })).content);
    expect(m.header.get("$INSUNITS")).toEqual(["6"]);
    expect(m.header.get("$MEASUREMENT")).toEqual(["1"]);
    expect(texts(m.entities, "DIMENSIONS")).toContain("Plot width 12 m");
  });

  it("draws the plot boundary at exactly the customer's width and length, from the origin, as a closed polyline", () => {
    const plots = polylines(dxf.entities, "PLOT_BOUNDARY");
    expect(plots).toHaveLength(layout.floors.length); // one per floor view
    const first = plots[0];
    expect(first.codes.get(70)).toEqual(["1"]); // closed
    expect(first.vertices).toHaveLength(4);
    expect(bbox(first.vertices)).toEqual({ minX: 0, maxX: 30, minY: 0, maxY: 40 });
  });

  it("dimensions the two real measurements, and only those", () => {
    expect(texts(dxf.entities, "DIMENSIONS").sort()).toEqual(["Plot length 40 ft", "Plot length 40 ft", "Plot width 30 ft", "Plot width 30 ft"]);
  });

  it("keeps the room outlines inside the building zone, inside the plot, and filling the zone exactly", () => {
    const ground = layout.floors[0];
    const zone = polylines(dxf.entities, "BUILDING_ZONE")[0].vertices;
    const rooms = polylines(dxf.entities, "F1_ROOMS");
    expect(rooms).toHaveLength(ground.rooms.length);
    const z = bbox(zone);
    for (const r of rooms) {
      const b = bbox(r.vertices);
      expect(b.minX).toBeGreaterThanOrEqual(z.minX - 1e-3);
      expect(b.maxX).toBeLessThanOrEqual(z.maxX + 1e-3);
      expect(b.minY).toBeGreaterThanOrEqual(z.minY - 1e-3);
      expect(b.maxY).toBeLessThanOrEqual(z.maxY + 1e-3);
    }
    expect(z.minX).toBeGreaterThan(0);
    expect(z.maxX).toBeLessThan(30);
    const total = rooms.reduce((sum, r) => sum + area(r.vertices), 0);
    expect(Math.abs(total - area(zone)) / area(zone)).toBeLessThan(1e-3);
  });

  it("matches the on-screen sketch: every room sits at the same proportional position in the SVG and the DXF", () => {
    const rooms = polylines(dxf.entities, "F1_ROOMS");
    const svg = renderFloorPlanSvg(layout, 0);
    layout.floors[0].rooms.forEach((room, i) => {
      const b = bbox(rooms[i].vertices);
      expect(b.minX / 30).toBeCloseTo((room.x - layout.plot.x) / layout.plot.width, 3);
      expect(b.maxX / 30).toBeCloseTo((room.x + room.width - layout.plot.x) / layout.plot.width, 3);
      // The sketch has y down with the front edge at the bottom; the DXF has y up with the front edge at 0.
      expect(b.minY / 40).toBeCloseTo((layout.plot.y + layout.plot.height - (room.y + room.height)) / layout.plot.height, 3);
      // The sketch writes the full label when it fits and just the number when it does not.
      expect(svg.includes(`>${room.number}. ${room.label}<`) || svg.includes(`>${room.number}<`)).toBe(true);
    });
  });

  it("labels each room with its number and name, and the parking strip", () => {
    const labels = texts(dxf.entities, "F1_LABELS");
    for (const room of layout.floors[0].rooms) expect(labels.some((t) => t === `${room.number}. ${room.label}` || t === String(room.number))).toBe(true);
    expect(labels.some((t) => t.startsWith("Parking"))).toBe(true);
  });

  it("puts each floor on its own layers, side by side without overlap", () => {
    expect(dxf.layerTable).toEqual(expect.arrayContaining(["PLOT_BOUNDARY", "BUILDING_ZONE", "F1_ROOMS", "F2_ROOMS", "F1_LABELS", "F2_LABELS", "DIMENSIONS", "NOTES", "PARKING"]));
    const [first, second] = polylines(dxf.entities, "PLOT_BOUNDARY").map((p) => bbox(p.vertices));
    expect(second.minX).toBeGreaterThan(first.maxX);
    expect(polylines(dxf.entities, "F2_ROOMS")).toHaveLength(layout.floors[1].rooms.length);
    expect(polylines(dxf.entities, "PARKING")).toHaveLength(1); // ground floor only
  });

  it("says plainly what it is not, on the drawing itself", () => {
    const notes = texts(dxf.entities, "NOTES").join("\n");
    expect(notes).toContain(FLOOR_PLAN_DISCLAIMER.replace("—", "-"));
    expect(notes).toContain("No room sizes, wall thicknesses, doors, windows or openings are given or drawn");
    expect(notes).toContain("Do not take dimensions from the room outlines");
    expect(notes).toContain("Plot outline and dimensions are at true size");
    expect(notes).toContain("not by an AI model");
  });

  it("contains only entities that the data supports: no doors, windows, hatches, blocks or dimensions it cannot back", () => {
    const types = new Set(dxf.entities.map((e) => e.type));
    expect([...types].sort()).toEqual(["LINE", "POLYLINE", "TEXT"]);
    expect(dxf.sections.get("BLOCKS")).toEqual([]);
  });

  it("is deterministic and free of anything but ASCII", () => {
    expect(build(layout).content).toBe(out.content);
    expect(/[^\x20-\x7e\r\n]/.test(out.content)).toBe(false);
  });
});

describe("the DXF file for other plots", () => {
  it("a single floor with no parking has one view and no PARKING layer", () => {
    const d = parse(build(layoutOf({ floors: 1, parkingSpaces: 0, bedrooms: 1, bathrooms: 1 })).content);
    expect(polylines(d.entities, "PLOT_BOUNDARY")).toHaveLength(1);
    expect(d.layerTable).not.toContain("PARKING");
    expect(d.layerTable).not.toContain("F2_ROOMS");
  });

  it("a very elongated plot is still dimensioned and outlined at its true size, and is marked not to scale", () => {
    const layout = layoutOf({ plotWidth: 10, plotLength: 90, floors: 1 });
    expect(layout.notToScale).toBe(true);
    const d = parse(build(layout).content);
    expect(bbox(polylines(d.entities, "PLOT_BOUNDARY")[0].vertices)).toEqual({ minX: 0, maxX: 10, minY: 0, maxY: 90 });
    expect(texts(d.entities, "NOTES").join("\n")).toContain("Not to scale");
  });

  it("handles fractional dimensions without noise", () => {
    const d = parse(build(layoutOf({ plotWidth: 33.3, plotLength: 41.7, floors: 1 })).content);
    expect(bbox(polylines(d.entities, "PLOT_BOUNDARY")[0].vertices)).toEqual({ minX: 0, maxX: 33.3, minY: 0, maxY: 41.7 });
    expect(texts(d.entities, "DIMENSIONS")).toContain("Plot width 33.3 ft");
  });

  it("refuses an unsupported unit or an empty or degenerate layout instead of writing a wrong file", () => {
    const base = layoutOf();
    expect(buildFloorPlanDxf({ ...base, unit: "yd" })).toEqual({ ok: false, reason: "unsupported_unit" });
    expect(buildFloorPlanDxf({ ...base, floors: [] })).toEqual({ ok: false, reason: "no_floors" });
    expect(buildFloorPlanDxf({ ...base, plotWidth: 0 })).toEqual({ ok: false, reason: "bad_plot" });
    expect(buildFloorPlanDxf({ ...base, plot: { ...base.plot, width: 0 } })).toEqual({ ok: false, reason: "bad_plot" });
  });
});

describe("dxfText", () => {
  it("keeps printable ASCII, turns everything else into a hyphen or space, and bounds the length", () => {
    expect(dxfText("Plot — 30 ft")).toBe("Plot - 30 ft");
    expect(dxfText("a\nb\tc")).toBe("a b c");
    expect(dxfText("café")).toBe("caf-");
    expect(dxfText("x".repeat(500))).toHaveLength(200);
  });
});

describe("layoutFromRequirements: missing or unsupported geometry", () => {
  it("gives nothing for project types without a layout, and for answers that are incomplete or invalid", () => {
    expect(layoutFromRequirements("INTERIOR", storedRequirements("INTERIOR"))).toBeNull();
    expect(layoutFromRequirements("LANDSCAPE", storedRequirements("LANDSCAPE"))).toBeNull();
    expect(layoutFromRequirements("EMPTY_PLOT", { schemaVersion: 1 })).toBeNull();
    expect(layoutFromRequirements("EMPTY_PLOT", null)).toBeNull();
    expect(layoutFromRequirements("EMPTY_PLOT", { ...storedRequirements("EMPTY_PLOT"), space: { ...REQUIREMENTS.EMPTY_PLOT.space, plotWidth: -5 } })).toBeNull();
  });
});

// Optional: DXF_OUT=<directory> writes sample files so an external CAD parser can check them.
if (process.env.DXF_OUT) {
  it("writes sample files for external validation", () => {
    mkdirSync(process.env.DXF_OUT!, { recursive: true });
    const samples: Record<string, PlanLayout> = {
      "two-floors-ft.dxf": layoutFromRequirements("EMPTY_PLOT", storedRequirements("EMPTY_PLOT"))!,
      "one-floor-m.dxf": layoutOf({ unit: "m", plotWidth: 12, plotLength: 18, floors: 1, parkingSpaces: 0 }),
      "elongated.dxf": layoutOf({ plotWidth: 10, plotLength: 90, floors: 1 }),
      "three-floors.dxf": layoutOf({ floors: 3, bedrooms: 5, bathrooms: 4, spaces: ["living", "dining", "kitchen", "puja", "study", "utility", "storage", "stairs", "balcony"] }),
    };
    for (const [name, layout] of Object.entries(samples)) writeFileSync(path.join(process.env.DXF_OUT!, name), build(layout).content);
  });
}
