import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getImageProvider } from "@/lib/generation/provider";
import {
  GENERATED_IMAGE_MAX_BYTES,
  ImageProviderUnavailableError,
  readImageSize,
  validateImageOutputs,
  withTimeout,
  type ImageGenerationRequest,
  type ImageView,
} from "@/lib/providers/images";
import { ProviderError } from "@/lib/providers/interfaces";
import { createMockImageProvider, MOCK_IMAGE_LABEL, renderMockImage } from "@/lib/providers/mock-image";

const VIEWS: ImageView[] = [
  { key: "exterior_front", assetType: "EXTERIOR_CONCEPT", label: "Exterior concept", instruction: "x" },
  { key: "interior_main", assetType: "INTERIOR_CONCEPT", label: "Interior concept", instruction: "y" },
];
const request = (views: ImageView[] = VIEWS): ImageGenerationRequest => ({
  promptVersion: "image-prompt-1",
  instructions: "trusted",
  views,
  customerData: { note: "synthetic" },
  requestId: "req-1",
  timeoutMs: 1000,
});

afterEach(() => vi.restoreAllMocks());

describe("the mock image provider", () => {
  it("returns one valid, labelled PNG per view, marked as mock", async () => {
    const result = await createMockImageProvider().generate(request());
    expect(result).toMatchObject({ provider: "mock", mock: true });
    expect(result.model).toMatch(/^mock-/);
    expect(result.outputs.map((o) => o.viewKey)).toEqual(["exterior_front", "interior_main"]);
    const checked = validateImageOutputs(result.outputs, VIEWS);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.images.every((i) => i.mimeType === "image/png" && i.width === 640 && i.height === 360)).toBe(true);
    }
  });

  it("really is a decodable PNG whose pixels carry the label band", () => {
    const png = renderMockImage("exterior_front", "Exterior concept", 0);
    // IDAT is the only chunk we need to inflate: find it after the 8-byte signature.
    let offset = 8;
    const idat: Uint8Array[] = [];
    while (offset < png.length) {
      const length = new DataView(png.buffer, png.byteOffset + offset).getUint32(0);
      const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
      if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(idat));
    expect(raw.length).toBe(360 * (640 + 1)); // filter byte + 640 pixels per row
    const row = (y: number) => raw.subarray(y * 641 + 1, (y + 1) * 641);
    expect(Math.max(...row(150))).toBe(255); // white label text on the dark band
    expect(row(112)[100]).toBe(30); // the dark band behind the label
  });

  it("states that it is a mock, not a design", () => {
    expect(MOCK_IMAGE_LABEL).toBe("MOCK — NOT A DESIGN");
  });

  it("is deterministic: the same view always gives the same bytes, other views differ", () => {
    const a = renderMockImage("exterior_front", "Exterior concept", 0);
    expect(Buffer.from(renderMockImage("exterior_front", "Exterior concept", 0)).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(renderMockImage("interior_main", "Interior concept", 1)).equals(Buffer.from(a))).toBe(false);
  });

  it("is small and quick", async () => {
    const started = Date.now();
    const result = await createMockImageProvider().generate(request());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.outputs.every((o) => o.bytes.length > 0 && o.bytes.length < 200 * 1024)).toBe(true);
  });

  it("makes no network call, sends nothing, reports no usage and has no spend plan", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const hooks = { onSent: vi.fn(), onUsage: vi.fn(), onNotSent: vi.fn() };
    const provider = createMockImageProvider();
    await provider.generate(request(), hooks);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hooks.onSent).not.toHaveBeenCalled();
    expect(hooks.onUsage).not.toHaveBeenCalled();
    expect(provider.usage).toBeUndefined();
    expect(provider.mock).toBe(true);
  });

  it("refuses no views or too many views", async () => {
    await expect(createMockImageProvider().generate(request([]))).rejects.toBeInstanceOf(ProviderError);
    const many = Array.from({ length: 9 }, (_, i) => ({ ...VIEWS[0], key: `v${i}` }));
    await expect(createMockImageProvider().generate(request(many))).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("getImageProvider", () => {
  it("gives the mock when no live mode is requested", () => {
    expect(getImageProvider({}).mock).toBe(true);
    expect(getImageProvider({ PROVIDER_MODE: "mock" }).mock).toBe(true);
  });

  it.each(["live", "LIVE", " live "])("reports live mode (%j) as unavailable and never falls back to the mock", (mode) => {
    expect(() => getImageProvider({ PROVIDER_MODE: mode })).toThrow(ImageProviderUnavailableError);
  });
});

describe("validateImageOutputs", () => {
  const good = () => createMockImageProvider().generate(request()).then((r) => r.outputs);
  const pngHeader = (width: number, height: number) => {
    const b = new Uint8Array(33);
    b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const v = new DataView(b.buffer);
    v.setUint32(16, width);
    v.setUint32(20, height);
    return b;
  };

  it("rejects empty, missing and partial results", async () => {
    expect(validateImageOutputs([], VIEWS)).toEqual({ ok: false, reason: "empty" });
    expect(validateImageOutputs(undefined, VIEWS)).toEqual({ ok: false, reason: "empty" });
    expect(validateImageOutputs((await good()).slice(0, 1), VIEWS)).toEqual({ ok: false, reason: "wrong_count" });
    expect(validateImageOutputs([{ viewKey: "exterior_front", mimeType: "image/png", bytes: new Uint8Array(0) }, { viewKey: "interior_main", mimeType: "image/png", bytes: new Uint8Array(0) }], VIEWS)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects a view that was not requested or is repeated", async () => {
    const [first] = await good();
    expect(validateImageOutputs([first, { ...first, viewKey: "other" }], VIEWS)).toEqual({ ok: false, reason: "unexpected_view" });
    expect(validateImageOutputs([first, first], VIEWS)).toEqual({ ok: false, reason: "unexpected_view" });
  });

  it("rejects a file that is too large", async () => {
    const [first, second] = await good();
    const big = new Uint8Array(GENERATED_IMAGE_MAX_BYTES + 1);
    big.set(first.bytes.subarray(0, 33));
    expect(validateImageOutputs([{ ...first, bytes: big }, second], VIEWS)).toEqual({ ok: false, reason: "too_large" });
  });

  it("trusts the file's bytes, not its declared type or name", async () => {
    const [first, second] = await good();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
    expect(validateImageOutputs([{ ...first, mimeType: "image/png", bytes: svg }, second], VIEWS)).toEqual({ ok: false, reason: "unsupported_type" });
    const gif = new TextEncoder().encode("GIF89a......................................");
    expect(validateImageOutputs([{ ...first, bytes: gif }, second], VIEWS)).toEqual({ ok: false, reason: "unsupported_type" });
    // a real PNG declared as JPEG is recorded as what it really is
    const checked = validateImageOutputs([{ ...first, mimeType: "image/jpeg" }, second], VIEWS);
    expect(checked.ok && checked.images[0].mimeType).toBe("image/png");
  });

  it.each([
    ["too small", 10, 10],
    ["too wide", 5000, 300],
    ["too tall", 300, 5000],
    ["zero", 0, 0],
  ])("rejects dimensions that are %s", async (_n, w, h) => {
    const [first, second] = await good();
    expect(validateImageOutputs([{ ...first, bytes: pngHeader(w, h) }, second], VIEWS)).toEqual({ ok: false, reason: "bad_dimensions" });
  });

  it("rejects a PNG whose header is truncated", async () => {
    const [first, second] = await good();
    expect(validateImageOutputs([{ ...first, bytes: first.bytes.subarray(0, 20) }, second], VIEWS)).toEqual({ ok: false, reason: "bad_dimensions" });
  });

  it("rejects anything that is not an array of outputs", () => {
    expect(validateImageOutputs({ outputs: [] }, VIEWS)).toEqual({ ok: false, reason: "empty" });
    expect(validateImageOutputs([null, null], VIEWS)).toEqual({ ok: false, reason: "unexpected_view" });
  });
});

describe("readImageSize", () => {
  it("reads JPEG size from the start-of-frame marker", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x02, 0x58, 3, 0, 0, 0]);
    expect(readImageSize(jpeg, "image/jpeg")).toEqual({ width: 600, height: 300 });
  });

  it("reads WebP size from VP8X and VP8L headers", () => {
    const riff = (kind: string, size: number) => {
      const b = new Uint8Array(40);
      b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
      b.set([...kind].map((c) => c.charCodeAt(0)), 12);
      return { b, size };
    };
    const x = riff("VP8X", 0).b;
    x.set([(800 - 1) & 255, (800 - 1) >> 8, 0, (400 - 1) & 255, (400 - 1) >> 8, 0], 24);
    expect(readImageSize(x, "image/webp")).toEqual({ width: 800, height: 400 });
    const l = riff("VP8L", 0).b;
    l[20] = 0x2f;
    const bits = (640 - 1) | ((360 - 1) << 14);
    l.set([bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], 21);
    expect(readImageSize(l, "image/webp")).toEqual({ width: 640, height: 360 });
  });

  it("returns null for anything it does not understand", () => {
    expect(readImageSize(new Uint8Array(5), "image/png")).toBeNull();
    expect(readImageSize(new Uint8Array(5), "image/jpeg")).toBeNull();
    expect(readImageSize(new Uint8Array(5), "image/webp")).toBeNull();
    expect(readImageSize(new Uint8Array(40), "image/gif")).toBeNull();
  });
});

describe("withTimeout", () => {
  it("passes a result through, and fails a call that takes too long", async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(withTimeout(new Promise(() => undefined), 20)).rejects.toMatchObject({ code: "timeout" });
  });
});
