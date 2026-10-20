import { deflateSync } from "node:zlib";
import { ProviderError } from "./interfaces";
import type { ImageGenerationProvider, ImageGenerationRequest, ImageGenerationResult } from "./images";

/**
 * The MOCK image generator. It draws a plain placeholder with a large, unmistakable
 * "MOCK — NOT A DESIGN" label. It makes no network call, uses no AI model, costs nothing,
 * and is deterministic: the same view always produces the same bytes. It is NOT an
 * architectural rendering and must never be presented as one, as AI-generated, or as
 * suitable for construction.
 *
 * It is selected only by an explicit mock configuration (see getImageProvider). A failed
 * or unavailable live provider never falls back to it.
 */

export const MOCK_IMAGE_LABEL = "MOCK — NOT A DESIGN";
export const MOCK_IMAGE_MODEL = "mock-placeholder-1";
const WIDTH = 640;
const HEIGHT = 360;
const MAX_VIEWS = 8;

// ---------------------------------------------------------------------------
// A tiny 5x7 bitmap font: just what the labels need.
// ---------------------------------------------------------------------------
const GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "—": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  _: ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

const textWidth = (text: string, scale: number) => text.length * 6 * scale - scale;

function drawText(pixels: Uint8Array, text: string, scale: number, top: number, value: number) {
  const left = Math.floor((WIDTH - textWidth(text, scale)) / 2);
  [...text.toUpperCase()].forEach((ch, index) => {
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = left + index * 6 * scale + col * scale + dx;
            const y = top + row * scale + dy;
            if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) pixels[y * WIDTH + x] = value;
          }
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// PNG encoding (8-bit grayscale)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(pixels: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, WIDTH);
  view.setUint32(4, HEIGHT);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  const raw = new Uint8Array(HEIGHT * (WIDTH + 1)); // each row starts with filter type 0
  for (let y = 0; y < HEIGHT; y++) raw.set(pixels.subarray(y * WIDTH, (y + 1) * WIDTH), y * (WIDTH + 1) + 1);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** Deterministic placeholder for one view: diagonal stripes, a dark band, and the label. */
export function renderMockImage(viewKey: string, caption: string, index: number): Uint8Array {
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  let seed = index;
  for (const ch of viewKey) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
  const phase = seed % 32;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) pixels[y * WIDTH + x] = (x + y + phase) % 32 < 16 ? 226 : 246;
  }
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (x < 8 || y < 8 || x >= WIDTH - 8 || y >= HEIGHT - 8) pixels[y * WIDTH + x] = 40;
    }
  }
  for (let y = 112; y < 248; y++) pixels.fill(30, y * WIDTH + 20, y * WIDTH + WIDTH - 20);
  drawText(pixels, MOCK_IMAGE_LABEL, 5, 126, 255);
  drawText(pixels, caption.slice(0, 40), 3, 188, 220);
  drawText(pixels, "PLACEHOLDER - NO AI MODEL USED", 2, 290, 60);
  return encodePng(pixels);
}

export function createMockImageProvider(): ImageGenerationProvider {
  return {
    id: "mock",
    model: MOCK_IMAGE_MODEL,
    mock: true,
    async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      // Nothing is ever sent anywhere: no onSent, no usage, no network.
      if (request.views.length === 0 || request.views.length > MAX_VIEWS) {
        throw new ProviderError("unsupported_input", "the mock supports between 1 and 8 views");
      }
      return {
        provider: "mock",
        model: MOCK_IMAGE_MODEL,
        mock: true,
        outputs: request.views.map((view, index) => ({
          viewKey: view.key,
          mimeType: "image/png",
          bytes: renderMockImage(view.key, view.label, index),
        })),
      };
    },
  };
}
