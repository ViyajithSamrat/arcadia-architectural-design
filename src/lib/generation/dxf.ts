import { FLOOR_PLAN_DISCLAIMER, type PlanLayout, type Rect } from "./floor-plan";

/**
 * An editable 2D CAD file (DXF, release 12 ASCII, which every common CAD program opens) written from
 * the SAME structured layout that draws the on-screen sketch (floor-plan.ts). It never touches the
 * AI-generated images and extracts nothing from pixels.
 *
 * What it contains, and why that is all it contains:
 *   - the PLOT BOUNDARY at true size, in the unit the customer chose. The plot width, plot length and
 *     unit are the only measurements the customer gave, so they are the only real dimensions here,
 *     and they are dimensioned on the drawing.
 *   - the building zone, the parking strip and one closed outline per requested room or space, with
 *     its number and name, on layers of their own. These are SCHEMATIC blocks placed by a fixed drawing
 *     rule: no room size was ever asked for, so none is drawn as a dimension, and nothing here is a
 *     wall thickness, a door, a window or an opening. They are not invented because no source
 *     data exists for them.
 *   - a notes block that says so, on a layer of its own, on every drawing.
 *
 * Coordinates: the file's unit is the plot unit (feet or metres, declared in $INSUNITS), origin at the
 * front-left corner of the plot, x along the plot width, y along the plot length (the front edge is y = 0).
 * The sketch's own coordinates are mapped onto that rectangle, so the plot is exactly plotWidth by
 * plotLength. When the plot is more elongated than the sketch allows (layout.notToScale) the room blocks
 * are stretched with it and the notes say their proportions are schematic.
 *
 * Several floors are laid side by side in one file, each with its own layers (F1_ROOMS, F2_ROOMS ...).
 * The output is deterministic: the same layout always gives byte-identical text.
 */

export const DXF_VERSION = "dxf-1";

const NEWLINE = "\r\n";

/** AutoCAD colour indexes. */
const COLOR = { plot: 7, zone: 8, parking: 9, rooms: 3, labels: 7, dimensions: 4, notes: 1 } as const;

/** $INSUNITS values: 2 = feet, 6 = metres. */
const INSUNITS: Readonly<Record<string, number>> = { ft: 2, m: 6 };

/** Text that R12 DXF can carry: printable ASCII only (anything else becomes "-"), single line, bounded. */
export function dxfText(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code >= 0x20 && code < 0x7f ? ch : code === 0x09 || code === 0x0a || code === 0x0d ? " " : "-";
  }
  return out.slice(0, 200);
}

/** Up to three decimals, no exponent, never "-0". */
function n(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("dxf: a coordinate is not finite");
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) || rounded === 0 ? "0" : String(rounded);
}

/** The measurement as the customer typed it, without floating-point noise. */
const measure = (value: number) => String(Number(value.toFixed(2)));

type Layer = { name: string; color: number };

class Writer {
  readonly entities: string[] = [];
  readonly layers = new Map<string, Layer>();
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  layer(name: string, color: number): string {
    if (!/^[A-Z0-9_]{1,31}$/.test(name)) throw new RangeError(`dxf: bad layer name ${name}`);
    if (!this.layers.has(name)) this.layers.set(name, { name, color });
    return name;
  }

  private extend(x: number, y: number) {
    this.minX = Math.min(this.minX, x);
    this.minY = Math.min(this.minY, y);
    this.maxX = Math.max(this.maxX, x);
    this.maxY = Math.max(this.maxY, y);
  }

  private pair(code: number, value: string | number) {
    this.entities.push(`${code}${NEWLINE}${value}`);
  }

  line(layer: string, x1: number, y1: number, x2: number, y2: number) {
    this.extend(x1, y1);
    this.extend(x2, y2);
    this.pair(0, "LINE");
    this.pair(8, layer);
    this.pair(10, n(x1));
    this.pair(20, n(y1));
    this.pair(30, 0);
    this.pair(11, n(x2));
    this.pair(21, n(y2));
    this.pair(31, 0);
  }

  /** A closed polyline through the points (R12 style: POLYLINE, VERTEX..., SEQEND). */
  closedPolyline(layer: string, points: readonly (readonly [number, number])[]) {
    this.pair(0, "POLYLINE");
    this.pair(8, layer);
    this.pair(66, 1);
    this.pair(10, 0);
    this.pair(20, 0);
    this.pair(30, 0);
    this.pair(70, 1);
    for (const [x, y] of points) {
      this.extend(x, y);
      this.pair(0, "VERTEX");
      this.pair(8, layer);
      this.pair(10, n(x));
      this.pair(20, n(y));
      this.pair(30, 0);
    }
    this.pair(0, "SEQEND");
    this.pair(8, layer);
  }

  rect(layer: string, x: number, y: number, width: number, height: number) {
    this.closedPolyline(layer, [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ]);
  }

  /** Text; `center` places it by its middle, otherwise by its left baseline. */
  text(layer: string, x: number, y: number, height: number, content: string, options: { center?: boolean; rotation?: number } = {}) {
    this.extend(x, y);
    this.pair(0, "TEXT");
    this.pair(8, layer);
    this.pair(10, n(x));
    this.pair(20, n(y));
    this.pair(30, 0);
    this.pair(40, n(height));
    this.pair(1, dxfText(content));
    if (options.rotation) this.pair(50, n(options.rotation));
    if (options.center) {
      this.pair(72, 1);
      this.pair(11, n(x));
      this.pair(21, n(y));
      this.pair(31, 0);
      this.pair(73, 2);
    }
  }
}

/** A label height that fits the box, trying the full text and then its number; null when nothing fits. */
function fitText(box: { width: number; height: number }, content: string, base: number): number | null {
  for (const size of [base, base * 0.75, base * 0.5]) {
    if (content.length * size * 0.6 <= box.width * 0.92 && size * 1.8 <= box.height) return size;
  }
  return null;
}

export type DxfResult = { ok: true; content: string; floors: number; units: string } | { ok: false; reason: "no_floors" | "bad_plot" | "unsupported_unit" };

export function buildFloorPlanDxf(layout: PlanLayout): DxfResult {
  const units = INSUNITS[layout.unit];
  if (units === undefined) return { ok: false, reason: "unsupported_unit" };
  if (layout.floors.length === 0) return { ok: false, reason: "no_floors" };
  if (!(layout.plotWidth > 0) || !(layout.plotLength > 0) || !(layout.plot.width > 0) || !(layout.plot.height > 0)) return { ok: false, reason: "bad_plot" };

  const W = layout.plotWidth;
  const L = layout.plotLength;
  const sx = W / layout.plot.width;
  const sy = L / layout.plot.height;
  const textHeight = Math.max(W, L) / 55;
  const gap = Math.max(W * 0.3, textHeight * 12);
  const w = new Writer();

  const toRect = (r: Rect, ox: number): Rect => ({
    x: ox + (r.x - layout.plot.x) * sx,
    // The sketch has y down with the front edge at the bottom; CAD has y up with the front edge at y = 0.
    y: (layout.plot.y + layout.plot.height - (r.y + r.height)) * sy,
    width: r.width * sx,
    height: r.height * sy,
  });

  layout.floors.forEach((floor, index) => {
    const ox = index * (W + gap);
    const f = index + 1;
    const plotLayer = w.layer("PLOT_BOUNDARY", COLOR.plot);
    const zoneLayer = w.layer("BUILDING_ZONE", COLOR.zone);
    const roomLayer = w.layer(`F${f}_ROOMS`, COLOR.rooms);
    const labelLayer = w.layer(`F${f}_LABELS`, COLOR.labels);
    const dimLayer = w.layer("DIMENSIONS", COLOR.dimensions);
    const noteLayer = w.layer("NOTES", COLOR.notes);

    w.rect(plotLayer, ox, 0, W, L);
    const zone = toRect(layout.zone, ox);
    w.rect(zoneLayer, zone.x, zone.y, zone.width, zone.height);

    if (floor.parking) {
      const parkingLayer = w.layer("PARKING", COLOR.parking);
      const p = toRect(floor.parking, ox);
      w.rect(parkingLayer, p.x, p.y, p.width, p.height);
      const label = `Parking (${floor.parking.spaces} ${floor.parking.spaces === 1 ? "space" : "spaces"})`;
      const size = fitText(p, label, textHeight);
      if (size !== null) w.text(labelLayer, p.x + p.width / 2, p.y + p.height / 2, size, label, { center: true });
    }

    for (const room of floor.rooms) {
      const r = toRect(room, ox);
      w.rect(roomLayer, r.x, r.y, r.width, r.height);
      const full = `${room.number}. ${room.label}`;
      const short = String(room.number);
      const fullSize = fitText(r, full, textHeight);
      if (fullSize !== null) w.text(labelLayer, r.x + r.width / 2, r.y + r.height / 2, fullSize, full, { center: true });
      else {
        const shortSize = fitText(r, short, textHeight);
        if (shortSize !== null) w.text(labelLayer, r.x + r.width / 2, r.y + r.height / 2, shortSize, short, { center: true });
      }
    }

    // Plot dimensions: the two real measurements, as plain lines and text on their own layer.
    const tick = textHeight * 0.6;
    const widthY = -textHeight * 2.5;
    w.line(dimLayer, ox, widthY, ox + W, widthY);
    w.line(dimLayer, ox, -textHeight * 0.5, ox, widthY - tick);
    w.line(dimLayer, ox + W, -textHeight * 0.5, ox + W, widthY - tick);
    w.text(dimLayer, ox + W / 2, widthY - textHeight * 1.4, textHeight, `Plot width ${measure(W)} ${layout.unit}`, { center: true });
    const lengthX = ox - textHeight * 2.5;
    w.line(dimLayer, lengthX, 0, lengthX, L);
    w.line(dimLayer, ox - textHeight * 0.5, 0, lengthX - tick, 0);
    w.line(dimLayer, ox - textHeight * 0.5, L, lengthX - tick, L);
    w.text(dimLayer, lengthX - textHeight * 1.0, L / 2, textHeight, `Plot length ${measure(L)} ${layout.unit}`, { center: true, rotation: 90 });

    w.text(noteLayer, ox, L + textHeight * 2.2, textHeight * 1.4, `${floor.name} - schematic layout`);
    w.text(noteLayer, ox, L + textHeight * 0.8, textHeight, layout.facing ? `Front edge (y = 0) faces ${layout.facing}` : "Facing direction not given");

    const notes = [
      FLOOR_PLAN_DISCLAIMER,
      `Only the plot width, plot length and unit (${layout.unit}) come from the customer. Room outlines are schematic blocks placed by a fixed rule.`,
      "No room sizes, wall thicknesses, doors, windows or openings are given or drawn. Do not take dimensions from the room outlines.",
      layout.notToScale ? "The plot is very elongated, so room block proportions are stretched with it. Not to scale." : "Plot outline and dimensions are at true size.",
      `Drawn by the app from the project answers, not by an AI model. ${layout.version} / ${DXF_VERSION}`,
    ];
    notes.forEach((line, i) => w.text(noteLayer, ox, -textHeight * (7 + i * 1.6), textHeight * 0.9, line));
  });

  if (!Number.isFinite(w.minX) || !Number.isFinite(w.maxX)) return { ok: false, reason: "bad_plot" };

  const header = [
    [0, "SECTION"],
    [2, "HEADER"],
    [9, "$ACADVER"],
    [1, "AC1009"],
    [9, "$INSUNITS"],
    [70, units],
    [9, "$MEASUREMENT"],
    [70, layout.unit === "m" ? 1 : 0],
    [9, "$EXTMIN"],
    [10, n(w.minX)],
    [20, n(w.minY)],
    [30, 0],
    [9, "$EXTMAX"],
    [10, n(w.maxX)],
    [20, n(w.maxY)],
    [30, 0],
    [0, "ENDSEC"],
  ];

  const layers = [...w.layers.values()];
  const tables = [
    [0, "SECTION"],
    [2, "TABLES"],
    [0, "TABLE"],
    [2, "LTYPE"],
    [70, 1],
    [0, "LTYPE"],
    [2, "CONTINUOUS"],
    [70, 0],
    [3, "Solid line"],
    [72, 65],
    [73, 0],
    [40, "0.0"],
    [0, "ENDTAB"],
    [0, "TABLE"],
    [2, "LAYER"],
    [70, layers.length],
    ...layers.flatMap((l) => [
      [0, "LAYER"],
      [2, l.name],
      [70, 0],
      [62, l.color],
      [6, "CONTINUOUS"],
    ]),
    [0, "ENDTAB"],
    [0, "TABLE"],
    [2, "STYLE"],
    [70, 1],
    [0, "STYLE"],
    [2, "STANDARD"],
    [70, 0],
    [40, "0.0"],
    [41, "1.0"],
    [50, "0.0"],
    [71, 0],
    [42, "2.5"],
    [3, "txt"],
    [4, ""],
    [0, "ENDTAB"],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "BLOCKS"],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "ENTITIES"],
  ];

  const lines = (pairs: (string | number)[][]) => pairs.map(([code, value]) => `${code}${NEWLINE}${value}`);
  const content = [...lines(header), ...lines(tables), ...w.entities, `0${NEWLINE}ENDSEC`, `0${NEWLINE}EOF`].join(NEWLINE) + NEWLINE;
  return { ok: true, content, floors: layout.floors.length, units: layout.unit };
}
