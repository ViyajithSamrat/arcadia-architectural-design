/**
 * Strict WAV checking for speech-to-text uploads.
 *
 * Only one shape is accepted: RIFF/WAVE, PCM (format 1), mono, 16-bit, 8 to 48 kHz. The
 * duration is computed here from the validated data chunk, so the browser's claims (its
 * declared type, file name or any duration it sends) are never used to estimate a cost.
 * Anything malformed, inconsistent or unexpected is refused; nothing is decoded or repaired.
 *
 * Chunk rules (RIFF): each chunk is id(4) + size(4, little-endian) + body, and a body of odd
 * size is followed by one pad byte. Unknown chunks (LIST, fact, ...) are skipped. "fmt " must
 * appear exactly once and before "data"; "data" must appear exactly once.
 */

export const WAV_MIN_SAMPLE_RATE = 8_000;
export const WAV_MAX_SAMPLE_RATE = 48_000;
export const WAV_MIN_SECONDS = 0.5;
const BYTES_PER_SAMPLE = 2;
/** Room for the RIFF, fmt and data headers plus small optional chunks. */
const HEADER_ALLOWANCE = 4096;
const MAX_CHUNKS = 64;

/** The largest file that could hold `maxSeconds` of the highest accepted sample rate. */
export function wavMaxBytes(maxSeconds: number): number {
  return Math.ceil(WAV_MAX_SAMPLE_RATE * BYTES_PER_SAMPLE * maxSeconds) + HEADER_ALLOWANCE;
}

export type WavRejection =
  | "empty"
  | "too_large"
  | "not_wav"
  | "truncated"
  | "bad_chunk"
  | "no_format"
  | "no_data"
  | "unsupported_encoding"
  | "not_mono"
  | "not_16_bit"
  | "bad_sample_rate"
  | "inconsistent_format"
  | "bad_data_size"
  | "too_short"
  | "too_long";

export type WavInfo = { sampleRate: number; dataBytes: number; seconds: number };

export type WavCheck = { ok: true; wav: WavInfo } | { ok: false; reason: WavRejection };

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

type Format = { audioFormat: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number };

export function parseWav(bytes: Uint8Array, limits: { maxSeconds: number; minSeconds?: number }): WavCheck {
  const reject = (reason: WavRejection): WavCheck => ({ ok: false, reason });
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return reject("empty");
  if (bytes.length > wavMaxBytes(limits.maxSeconds)) return reject("too_large");
  if (bytes.length < 12) return reject("truncated");
  if (tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") return reject("not_wav");

  // The RIFF size must describe exactly this file: nothing missing and nothing appended.
  const riffEnd = u32(bytes, 4) + 8;
  if (riffEnd > bytes.length) return reject("truncated");
  if (riffEnd < bytes.length) return reject("bad_chunk");

  let format: Format | null = null;
  let data: { size: number } | null = null;
  let offset = 12;
  let chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > MAX_CHUNKS) return reject("bad_chunk");
    if (offset + 8 > bytes.length) return reject("truncated");
    const id = tag(bytes, offset);
    const size = u32(bytes, offset + 4);
    const body = offset + 8;
    const end = body + size;
    if (end > bytes.length) return reject("truncated");

    if (id === "fmt ") {
      if (format || data) return reject("bad_chunk"); // a second fmt, or fmt after data
      if (size < 16) return reject("bad_chunk");
      if (size !== 16 && size !== 18) return reject("unsupported_encoding"); // e.g. WAVE_FORMAT_EXTENSIBLE
      if (size === 18 && u16(bytes, body + 16) !== 0) return reject("unsupported_encoding");
      format = {
        audioFormat: u16(bytes, body),
        channels: u16(bytes, body + 2),
        sampleRate: u32(bytes, body + 4),
        byteRate: u32(bytes, body + 8),
        blockAlign: u16(bytes, body + 12),
        bitsPerSample: u16(bytes, body + 14),
      };
    } else if (id === "data") {
      if (data) return reject("bad_chunk");
      if (!format) return reject("bad_chunk"); // data before fmt
      data = { size };
    }

    // A body of odd size is followed by a pad byte that must be present.
    const next = end + (size % 2);
    if (next > bytes.length) return reject("truncated");
    offset = next;
  }

  if (!format) return reject("no_format");
  if (!data) return reject("no_data");
  if (format.audioFormat !== 1) return reject("unsupported_encoding");
  if (format.channels !== 1) return reject("not_mono");
  if (format.bitsPerSample !== 16) return reject("not_16_bit");
  if (format.sampleRate < WAV_MIN_SAMPLE_RATE || format.sampleRate > WAV_MAX_SAMPLE_RATE) return reject("bad_sample_rate");
  if (format.blockAlign !== BYTES_PER_SAMPLE || format.byteRate !== format.sampleRate * BYTES_PER_SAMPLE) return reject("inconsistent_format");
  if (data.size === 0) return reject("empty");
  if (data.size % BYTES_PER_SAMPLE !== 0) return reject("bad_data_size");

  const seconds = data.size / format.byteRate;
  if (seconds < (limits.minSeconds ?? WAV_MIN_SECONDS)) return reject("too_short");
  if (seconds > limits.maxSeconds) return reject("too_long");
  return { ok: true, wav: { sampleRate: format.sampleRate, dataBytes: data.size, seconds } };
}

/** Customer-safe wording for a refusal. */
export function wavRejectionMessage(reason: WavRejection, maxSeconds: number): string {
  switch (reason) {
    case "too_short":
      return "The recording is too short. Record at least half a second.";
    case "too_long":
    case "too_large":
      return `The recording is too long. Keep it under ${maxSeconds} seconds.`;
    case "empty":
      return "The recording is empty.";
    case "unsupported_encoding":
    case "not_mono":
    case "not_16_bit":
    case "bad_sample_rate":
      return "This audio format is not supported. Use a mono, 16-bit WAV file, or record in the browser.";
    default:
      return "This file is not a valid WAV recording.";
  }
}
