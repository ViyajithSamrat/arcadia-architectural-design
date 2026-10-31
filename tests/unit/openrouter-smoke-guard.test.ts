import { describe, expect, it } from "vitest";
import { assessKey, assessModel, SpendGuard, worstCaseRequestUsd } from "../provider-smoke/openrouter-guard";

const models = (...m: object[]) => ({ data: m });
const imageModel = (pricing: object, extra: object = {}) => ({ id: "v/img", architecture: { output_modalities: ["image"] }, pricing, ...extra });
const textModel = (pricing: object, params: string[] = ["structured_outputs"]) => ({ id: "v/txt", architecture: { output_modalities: ["text"] }, supported_parameters: params, pricing });

describe("assessKey", () => {
  const key = (data: object) => ({ data });
  it("accepts a key whose own limit is within the budget and has credit left", () => {
    expect(assessKey(key({ limit: 5, limit_remaining: 4.2, usage: 0.8 }))).toMatchObject({ ok: true, usage: 0.8 });
  });
  it.each([
    ["no limit of its own", { limit: null, limit_remaining: null, usage: 1 }],
    ["a limit above the budget", { limit: 50, limit_remaining: 40, usage: 10 }],
    ["no credit left", { limit: 5, limit_remaining: 0, usage: 5 }],
    ["unreadable usage", { limit: 5, limit_remaining: 2 }],
  ])("refuses %s", (_n, data) => expect(assessKey(key(data)).ok).toBe(false));
  it("refuses an unreadable response", () => {
    expect(assessKey(null).ok).toBe(false);
    expect(assessKey({ data: "x" }).ok).toBe(false);
  });
});

describe("assessModel", () => {
  it("accepts an image model with a small per-token price and bounds the cost generously", () => {
    const out = assessModel(models(imageModel({ image_output: "0.00001" })), "v/img", "image");
    expect(out.ok).toBe(true);
    expect(out.worstCaseUsd).toBeCloseTo(0.08, 5);
  });
  it("uses the per-image price when the model has one", () => {
    expect(worstCaseRequestUsd(imageModel({ image: "0.02" }), "image")).toBeCloseTo(0.02, 5);
  });
  it.each([
    ["an unknown model", models(), "v/img", "image"],
    ["a model that cannot output images", models({ id: "v/img", architecture: { output_modalities: ["text"] }, pricing: { image: "0.01" } }), "v/img", "image"],
    ["variable (-1) pricing", models(imageModel({ image_output: "-1" })), "v/img", "image"],
    ["no price at all", models(imageModel({})), "v/img", "image"],
    ["a worst case above the per-request limit", models(imageModel({ image_output: "0.001" })), "v/img", "image"],
    ["a text model without structured outputs", models(textModel({ prompt: "0.000001", completion: "0.000002" }, ["temperature"])), "v/txt", "text"],
    ["a text model with unusable pricing", models(textModel({ prompt: "-1", completion: "-1" })), "v/txt", "text"],
  ] as const)("refuses %s", (_n, list, id, kind) => expect(assessModel(list, id, kind).ok).toBe(false));
  it("accepts a text model with structured outputs and a small price", () => {
    expect(assessModel(models(textModel({ prompt: "0.000001", completion: "0.000002" })), "v/txt", "text").ok).toBe(true);
  });
  it("refuses an unreadable list", () => expect(assessModel({}, "x", "image").ok).toBe(false));
});

describe("SpendGuard", () => {
  it("measures real spend from the usage counter and stops before the budget would be exceeded", () => {
    const g = new SpendGuard(10, 5);
    expect(g.spent(10)).toBe(0);
    expect(g.mayContinue(10, 1)).toBe(true);
    expect(g.mayContinue(13.5, 1)).toBe(true); // 3.5 spent + 1 worst case = 4.5, within 5
    expect(g.mayContinue(14.5, 1)).toBe(false); // 4.5 spent + 1 = 5.5, over
  });
  it("is exact at the boundary and rejects non-finite estimates", () => {
    const g = new SpendGuard(0, 5);
    expect(g.mayContinue(4, 1)).toBe(true);
    expect(g.mayContinue(4.01, 1)).toBe(false);
    expect(g.mayContinue(0, Number.NaN)).toBe(false);
    expect(g.mayContinue(0, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
