import { describe, expect, it } from "vitest";
import {
  describeFloorPlan,
  escapeXml,
  FLOOR_PLAN_DISCLAIMER,
  FLOOR_PLAN_HEIGHT,
  FLOOR_PLAN_VERSION,
  FLOOR_PLAN_WIDTH,
  layoutFloorPlan,
  MAX_DRAWN_RATIO,
  MAX_SVG_CHARS,
  parsePlanInput,
  renderFloorPlanSvg,
  svgDataUrl,
  type PlanInput,
  type PlanLayout,
  type Rect,
} from "@/lib/generation/floor-plan";
import { JOURNEY_STEPS } from "@/lib/journeys/steps";

const BASE: PlanInput = { plotWidth: 30, plotLength: 40, unit: "ft", orientation: "E", floors: 2, bedrooms: 3, bathrooms: 2, parkingSpaces: 1, spaces: ["living", "kitchen", "dining"] };

function input(patch: Partial<PlanInput> = {}): PlanInput {
  const parsed = parsePlanInput({ ...BASE, ...patch });
  if (!parsed.ok) throw new Error("invalid fixture");
  return parsed.input;
}

const ALL_SPACES = ["living", "kitchen", "dining", "stairs", "balcony", "utility", "study", "puja", "storage"];
const LARGEST: Partial<PlanInput> = { plotWidth: 1000, plotLength: 1, floors: 4, bedrooms: 10, bathrooms: 10, parkingSpaces: 6, spaces: ALL_SPACES };

/** Saved answers as the journey stores them, complete for every empty-plot step. */
const requirements = (space: Record<string, unknown> = {}, rooms: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  space: { plotWidth: 30, plotLength: 40, unit: "ft", orientation: "E", floors: 2, location: "Chennai <b>bold</b>", ...space },
  rooms: { bedrooms: 3, bathrooms: 2, parkingSpaces: 1, spaces: ["living", "kitchen"], ...rooms },
  preferences: { style: "modern", budgetBand: "standard", vastu: "undecided", exteriorViews: 1, interiorViews: 1, frontGarden: false },
  description: {},
});

const EPS = 1e-6;
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && inner.x + inner.width <= outer.x + outer.width + EPS && inner.y + inner.height <= outer.y + outer.height + EPS;
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const allSvgs = (layout: PlanLayout) => layout.floors.map((_, i) => renderFloorPlanSvg(layout, i));

describe("parsePlanInput: the answers are checked again on the server", () => {
  it("accepts complete answers and puts the spaces in form order without duplicates", () => {
    const parsed = parsePlanInput({ ...BASE, spaces: ["dining", "living", "dining", "kitchen"] });
    expect(parsed).toEqual({ ok: true, input: { ...BASE, spaces: ["living", "kitchen", "dining"] } });
  });

  const rejected: [string, Record<string, unknown>][] = [
    ["a NaN width", { plotWidth: Number.NaN }],
    ["an infinite length", { plotLength: Number.POSITIVE_INFINITY }],
    ["a negative infinite width", { plotWidth: Number.NEGATIVE_INFINITY }],
    ["a zero width", { plotWidth: 0 }],
    ["a negative length", { plotLength: -5 }],
    ["a width over the form's limit", { plotWidth: 1000.5 }],
    ["a width sent as text", { plotWidth: "30" }],
    ["a missing width", { plotWidth: undefined }],
    ["a fractional floor count", { floors: 1.5 }],
    ["five floors", { floors: 5 }],
    ["no bedroom", { bedrooms: 0 }],
    ["eleven bathrooms", { bathrooms: 11 }],
    ["negative parking", { parkingSpaces: -1 }],
    ["an unknown unit", { unit: "yd" }],
    ["an unknown space", { spaces: ["helipad"] }],
    ["markup as a space", { spaces: ["<svg onload=alert(1)>"] }],
    ["an unknown direction", { orientation: "UP" }],
    ["an extra field", { svg: "<svg/>" }],
  ];
  it.each(rejected)("refuses %s", (_name, patch) => {
    expect(parsePlanInput({ ...BASE, ...patch })).toEqual({ ok: false });
  });

  it.each([null, undefined, "30x40", [], 42])("refuses a non-object (%s)", (value) => {
    expect(parsePlanInput(value)).toEqual({ ok: false });
  });

  it("uses exactly the journey's own limits", () => {
    for (const step of JOURNEY_STEPS.EMPTY_PLOT) {
      for (const field of step.fields) {
        if (field.kind !== "number" || !(field.name in BASE)) continue;
        expect(parsePlanInput({ ...BASE, [field.name]: field.max }).ok, `${field.name} at its maximum`).toBe(true);
        expect(parsePlanInput({ ...BASE, [field.name]: field.min }).ok, `${field.name} at its minimum`).toBe(true);
        expect(parsePlanInput({ ...BASE, [field.name]: field.max + 1 }).ok, `${field.name} above its maximum`).toBe(false);
        expect(parsePlanInput({ ...BASE, [field.name]: field.min - 1 }).ok, `${field.name} below its minimum`).toBe(false);
      }
    }
  });
});

describe("layoutFloorPlan: geometry", () => {
  const proportions: [number, number][] = [[30, 40], [40, 30], [50, 50], [20, 60], [60, 20], [1, 1000], [1000, 1], [12.5, 80.25]];
  const programmes: Partial<PlanInput>[] = [
    { floors: 1, bedrooms: 1, bathrooms: 1, parkingSpaces: 0, spaces: [] },
    {},
    LARGEST,
  ];

  for (const [w, l] of proportions) {
    for (const programme of programmes) {
      it(`fills the zone without gaps or overlaps for a ${w} x ${l} plot (${programme.floors ?? BASE.floors} floors, ${programme.bedrooms ?? BASE.bedrooms} bedrooms)`, () => {
        const layout = layoutFloorPlan(input({ ...programme, plotWidth: w, plotLength: l }));
        const area: Rect = { x: 0, y: 0, width: FLOOR_PLAN_WIDTH, height: FLOOR_PLAN_HEIGHT };
        expect(inside(layout.plot, area)).toBe(true);
        expect(inside(layout.zone, layout.plot)).toBe(true);
        expect(layout.zone.width).toBeGreaterThan(0);
        expect(layout.zone.height).toBeGreaterThan(0);
        for (const floor of layout.floors) {
          expect(floor.rooms.length).toBeGreaterThan(0);
          let covered = 0;
          floor.rooms.forEach((room, i) => {
            expect(room.width).toBeGreaterThan(0);
            expect(room.height).toBeGreaterThan(0);
            expect([room.x, room.y, room.width, room.height].every(Number.isFinite)).toBe(true);
            expect(inside(room, layout.zone)).toBe(true);
            for (const other of floor.rooms.slice(i + 1)) expect(overlap(room, other)).toBeLessThan(EPS);
            covered += room.width * room.height;
          });
          expect(covered).toBeCloseTo(layout.zone.width * layout.zone.height, 3);
          if (floor.parking) {
            expect(inside(floor.parking, layout.plot)).toBe(true);
            expect(overlap(floor.parking, layout.zone)).toBeLessThan(EPS);
          }
        }
      });
    }
  }

  it("draws both plot sides at one scale when the proportions allow it", () => {
    for (const [w, l] of [[30, 40], [40, 30], [50, 50], [20, 60], [60, 20], [12.5, 30.25]]) {
      const layout = layoutFloorPlan(input({ plotWidth: w, plotLength: l }));
      expect(layout.plot.width / layout.plot.height).toBeCloseTo(w / l, 9);
      expect(layout.notToScale).toBe(false);
    }
  });

  it("clamps very elongated plots, says so, and keeps the ratio at the limit", () => {
    for (const [w, l, ratio] of [[1, 1000, 1 / MAX_DRAWN_RATIO], [1000, 1, MAX_DRAWN_RATIO]]) {
      const layout = layoutFloorPlan(input({ plotWidth: w, plotLength: l }));
      expect(layout.notToScale).toBe(true);
      expect(layout.plot.width / layout.plot.height).toBeCloseTo(ratio, 9);
      expect(layout.assumptions.some((a) => a.includes("Not to scale"))).toBe(true);
      expect(renderFloorPlanSvg(layout, 0)).toContain("Not to scale");
    }
  });

  it("shows every requested bedroom and bathroom once, numbered without gaps", () => {
    const layout = layoutFloorPlan(input({ floors: 3, bedrooms: 5, bathrooms: 4 }));
    const labels = layout.floors.flatMap((f) => f.rooms.map((r) => r.label));
    expect(labels.filter((l) => l.startsWith("Bedroom "))).toHaveLength(5);
    expect(labels.filter((l) => l.startsWith("Bathroom "))).toHaveLength(4);
    expect(layout.floors.flatMap((f) => f.rooms.map((r) => r.number))).toEqual(labels.map((_, i) => i + 1));
    expect(layout.floors.map((f) => f.name)).toEqual(["Ground floor", "First floor", "Second floor"]);
  });

  it("keeps shared rooms on the ground floor, adds stairs to every floor of a multi-storey home and says why", () => {
    const layout = layoutFloorPlan(input({ floors: 2, spaces: ["living", "kitchen", "balcony"] }));
    const [ground, first] = layout.floors.map((f) => f.rooms.map((r) => r.label));
    expect(ground).toEqual(expect.arrayContaining(["Living room", "Kitchen", "Staircase"]));
    expect(first).toContain("Staircase");
    expect(first).toContain("Balcony");
    expect(first).not.toContain("Living room");
    expect(layout.assumptions.some((a) => a.startsWith("A staircase is shown"))).toBe(true);
    // asked for explicitly: no assumption needed
    expect(layoutFloorPlan(input({ spaces: ["stairs"] })).assumptions.some((a) => a.startsWith("A staircase is shown"))).toBe(false);
  });

  it("adds no staircase to a single-storey home unless one was asked for", () => {
    const labels = layoutFloorPlan(input({ floors: 1, spaces: [] })).floors[0].rooms.map((r) => r.label);
    expect(labels).not.toContain("Staircase");
  });

  it("marks a floor with nothing but circulation as open space instead of leaving it empty", () => {
    const layout = layoutFloorPlan(input({ floors: 4, bedrooms: 1, bathrooms: 1, spaces: [] }));
    expect(layout.floors[2].rooms.map((r) => r.label)).toEqual(["Staircase", "Open space (not allocated)"]);
    expect(layout.floors[3].rooms.map((r) => r.label)).toEqual(["Staircase", "Open space (not allocated)"]);
  });

  it("draws parking only when spaces were asked for, and only on the ground floor", () => {
    expect(layoutFloorPlan(input({ parkingSpaces: 0 })).floors.every((f) => f.parking === null)).toBe(true);
    const layout = layoutFloorPlan(input({ parkingSpaces: 2 }));
    expect(layout.floors[0].parking?.spaces).toBe(2);
    expect(layout.floors[1].parking).toBeNull();
  });

  it("states the facing direction only when it was given", () => {
    expect(layoutFloorPlan(input({ orientation: "NE" })).facing).toBe("North-east");
    for (const orientation of ["unknown", undefined] as const) {
      const layout = layoutFloorPlan(input({ orientation }));
      expect(layout.facing).toBeNull();
      expect(layout.assumptions).toContain("The direction the plot faces was not given.");
    }
  });
});

describe("determinism", () => {
  it("gives identical layouts and byte-identical SVG for identical answers", () => {
    const a = layoutFloorPlan(input(LARGEST));
    const b = layoutFloorPlan(input(LARGEST));
    expect(b).toEqual(a);
    expect(allSvgs(b)).toEqual(allSvgs(a));
  });

  it("is not affected by the order or repetition of the chosen spaces", () => {
    const a = allSvgs(layoutFloorPlan(input({ spaces: ["living", "kitchen", "puja"] })));
    const b = allSvgs(layoutFloorPlan(input({ spaces: ["puja", "kitchen", "living", "kitchen"] })));
    expect(b).toEqual(a);
  });

  it("describes the same saved answers identically every time", () => {
    expect(describeFloorPlan("EMPTY_PLOT", requirements())).toEqual(describeFloorPlan("EMPTY_PLOT", requirements()));
  });
});

describe("renderFloorPlanSvg: safe, bounded output", () => {
  const ALLOWED_ELEMENTS = new Set(["svg", "title", "rect", "text"]);

  it("uses only plain drawing elements: no script, handler, link, style, embedded image or external reference", () => {
    for (const programme of [{}, LARGEST]) {
      for (const svg of allSvgs(layoutFloorPlan(input(programme)))) {
        const elements = new Set([...svg.matchAll(/<([a-zA-Z][\w:-]*)/g)].map((m) => m[1]));
        expect([...elements].every((e) => ALLOWED_ELEMENTS.has(e))).toBe(true);
        expect(svg).not.toMatch(/script|foreignObject|<image|<a[\s>]|<style|href|url\(|\son[a-z]+=|javascript:|data:/i);
        // the namespace declaration is the only URL in the document
        expect(svg.match(/https?:\/\//g)).toEqual(["http://"]);
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 540"')).toBe(true);
        expect(svg.endsWith("</svg>")).toBe(true);
      }
    }
  });

  it("escapes every piece of text it writes", () => {
    const layout = layoutFloorPlan(input());
    const hostile = `<script>alert("x")</script> & 'y'`;
    layout.floors[0].name = hostile;
    layout.facing = hostile;
    const svg = renderFloorPlanSvg(layout, 0);
    expect(svg).not.toContain("<script");
    expect(svg).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;y&apos;");
  });

  it("escapeXml escapes markup characters and drops characters XML cannot carry", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;");
    expect(escapeXml("a\u0000b\u0007c\td\ne￿")).toBe("abc\td\ne");
    expect(escapeXml("Puja room — North-east")).toBe("Puja room — North-east");
  });

  it("never writes the customer's free text (such as the location) into the drawing", () => {
    const plan = describeFloorPlan("EMPTY_PLOT", requirements());
    expect(plan?.state).toBe("ready");
    if (plan?.state !== "ready") return;
    for (const floor of plan.floors) {
      const svg = decodeURIComponent(floor.dataUrl.slice(floor.dataUrl.indexOf(",") + 1));
      expect(svg).not.toContain("Chennai");
      expect(svg).not.toContain("<b>");
    }
  });

  it("states the plot dimensions as entered, the disclaimer and that no AI model drew it", () => {
    const svg = renderFloorPlanSvg(layoutFloorPlan(input({ plotWidth: 12.5, plotLength: 80.25, unit: "m" })), 0);
    expect(svg).toContain("Plot width 12.5 m");
    expect(svg).toContain("Plot length 80.25 m");
    expect(svg).toContain(escapeXml(FLOOR_PLAN_DISCLAIMER));
    expect(svg).toContain("not by an AI model");
    expect(svg).toContain(FLOOR_PLAN_VERSION);
    expect(FLOOR_PLAN_DISCLAIMER).toBe("Illustrative layout only — not CAD or a construction drawing.");
  });

  it("never draws a label larger than the block it labels", () => {
    for (const [w, l] of [[30, 40], [1, 1000], [1000, 1]]) {
      const layout = layoutFloorPlan(input({ ...LARGEST, plotWidth: w, plotLength: l }));
      layout.floors.forEach((floor, i) => {
        const svg = renderFloorPlanSvg(layout, i);
        for (const m of svg.matchAll(/<text x="[\d.]+" y="[\d.]+" font-size="(\d+)" text-anchor="middle">(\d+)(?:\. [^<]+)?<\/text>/g)) {
          const room = floor.rooms.find((r) => r.number === Number(m[2]));
          if (!room) continue;
          const content = m[0].slice(m[0].indexOf(">") + 1, m[0].lastIndexOf("<"));
          const size = Number(m[1]);
          expect(content.length * size * 0.6).toBeLessThanOrEqual(room.width - 6 + 1e-9);
          expect(size + 4).toBeLessThanOrEqual(room.height + 1e-9);
        }
      });
    }
  });

  it("stays small even for the largest home the form allows", () => {
    for (const svg of allSvgs(layoutFloorPlan(input(LARGEST)))) {
      expect(svg.length).toBeLessThan(MAX_SVG_CHARS / 2);
      expect([...svg.matchAll(/<(rect|text)\b/g)].length).toBeLessThan(120);
    }
  });

  it("refuses a floor that does not exist", () => {
    expect(() => renderFloorPlanSvg(layoutFloorPlan(input({ floors: 1 })), 1)).toThrow(RangeError);
  });

  it("wraps the SVG in an image data URL that decodes back to it", () => {
    const svg = renderFloorPlanSvg(layoutFloorPlan(input()), 0);
    const url = svgDataUrl(svg);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(svg);
  });
});

describe("describeFloorPlan: what a screen receives", () => {
  it("has no sketch for interior and landscape projects", () => {
    expect(describeFloorPlan("INTERIOR", requirements())).toBeNull();
    expect(describeFloorPlan("LANDSCAPE", requirements())).toBeNull();
  });

  it("returns one sized image per floor, the numbered blocks and the assumptions", () => {
    const plan = describeFloorPlan("EMPTY_PLOT", requirements({ floors: 3 }, { bedrooms: 4 }));
    expect(plan?.state).toBe("ready");
    if (plan?.state !== "ready") return;
    expect(plan.floors.map((f) => [f.name, f.width, f.height])).toEqual([
      ["Ground floor", 720, 540],
      ["First floor", 720, 540],
      ["Second floor", 720, 540],
    ]);
    expect(plan.floors.every((f) => f.dataUrl.startsWith("data:image/svg+xml;charset=utf-8,"))).toBe(true);
    expect(plan.rooms.filter((r) => r.label.startsWith("Bedroom "))).toHaveLength(4);
    expect(plan.rooms.map((r) => r.number)).toEqual(plan.rooms.map((_, i) => i + 1));
    expect(plan.version).toBe(FLOOR_PLAN_VERSION);
    expect(plan.disclaimer).toBe(FLOOR_PLAN_DISCLAIMER);
    expect(plan.assumptions.length).toBeGreaterThan(0);
  });

  it.each([
    ["nothing saved", {}],
    ["not an object", null],
    ["a missing step", { ...requirements(), rooms: undefined }],
    ["a dimension saved as text", requirements({ plotWidth: "30" })],
    ["a dimension out of range", requirements({ plotLength: 5000 })],
    ["a forged extra field", requirements({ svg: "<svg onload=alert(1)>" })],
  ])("is unavailable, and says nothing more, when the saved answers are not valid (%s)", (_name, saved) => {
    expect(describeFloorPlan("EMPTY_PLOT", saved)).toEqual({ state: "unavailable" });
  });
});
