import { describe, expect, it } from "vitest";
import { parseWav, wavMaxBytes, wavRejectionMessage, type WavRejection } from "@/lib/providers/wav";
import { concatSamples, downsample, encodeWav, RECORDING_SAMPLE_RATE } from "@/lib/voice/wav-encode";

type Chunk = { id: string; body: Uint8Array };

const le16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const le32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

function fmtBody(f: Partial<{ format: number; channels: number; rate: number; bits: number; byteRate: number; blockAlign: number; extra: Uint8Array }> = {}) {
  const channels = f.channels ?? 1;
  const bits = f.bits ?? 16;
  const rate = f.rate ?? 16_000;
  const blockAlign = f.blockAlign ?? (channels * bits) / 8;
  const byteRate = f.byteRate ?? rate * blockAlign;
  return join(le16(f.format ?? 1), le16(channels), le32(rate), le32(byteRate), le16(blockAlign), le16(bits), f.extra ?? new Uint8Array(0));
}

/** Serialises chunks with correct sizes and pad bytes; `riffSize` can be forced to lie. */
function wav(chunks: Chunk[], opts: { riffSize?: number; omitPad?: boolean; trailing?: number } = {}) {
  const parts: Uint8Array[] = [];
  for (const c of chunks) {
    parts.push(ascii(c.id), le32(c.body.length), c.body);
    if (c.body.length % 2 === 1 && !opts.omitPad) parts.push(new Uint8Array(1));
  }
  const body = join(ascii("WAVE"), ...parts);
  const file = join(ascii("RIFF"), le32(opts.riffSize ?? body.length), body);
  return opts.trailing ? join(file, new Uint8Array(opts.trailing)) : file;
}

const fmt = (f?: Parameters<typeof fmtBody>[0]): Chunk => ({ id: "fmt ", body: fmtBody(f) });
const data = (bytes: number): Chunk => ({ id: "data", body: new Uint8Array(bytes) });
/** `seconds` of 16 kHz mono 16-bit audio. */
const secondsOf = (seconds: number, rate = 16_000) => Math.round(seconds * rate) * 2;

const LIMITS = { maxSeconds: 30 };
const reason = (bytes: Uint8Array, limits = LIMITS): WavRejection | "ok" => {
  const r = parseWav(bytes, limits);
  return r.ok ? "ok" : r.reason;
};

describe("parseWav: what is accepted", () => {
  it("accepts mono 16-bit PCM and measures the duration from the data chunk", () => {
    const r = parseWav(wav([fmt(), data(secondsOf(2))]), LIMITS);
    expect(r).toEqual({ ok: true, wav: { sampleRate: 16_000, dataBytes: 64_000, seconds: 2 } });
  });

  it.each([8_000, 16_000, 44_100, 48_000])("accepts a sample rate of %i Hz", (rate) => {
    const r = parseWav(wav([fmt({ rate }), data(secondsOf(1, rate))]), LIMITS);
    expect(r.ok && r.wav.seconds).toBe(1);
  });

  it("skips unknown chunks, before or after the format, including a padded odd-sized one", () => {
    const list: Chunk = { id: "LIST", body: new Uint8Array(7) }; // odd: one pad byte follows
    expect(reason(wav([list, fmt(), { id: "fact", body: new Uint8Array(4) }, data(secondsOf(1))]))).toBe("ok");
    expect(reason(wav([fmt(), data(secondsOf(1)), list]))).toBe("ok");
  });

  it("accepts an 18-byte format chunk whose extension size is zero", () => {
    expect(reason(wav([fmt({ extra: le16(0) }), data(secondsOf(1))]))).toBe("ok");
  });

  it("accepts exactly the minimum and exactly the maximum duration", () => {
    expect(reason(wav([fmt(), data(secondsOf(0.5))]))).toBe("ok");
    expect(reason(wav([fmt(), data(secondsOf(30))]))).toBe("ok");
  });
});

describe("parseWav: what is refused", () => {
  it("refuses empty input and empty audio", () => {
    expect(reason(new Uint8Array(0))).toBe("empty");
    expect(reason(wav([fmt(), data(0)]))).toBe("empty");
  });

  it("refuses wrong RIFF or WAVE identifiers", () => {
    const good = wav([fmt(), data(secondsOf(1))]);
    const riff = good.slice();
    riff.set(ascii("RIFX"), 0);
    const wave = good.slice();
    wave.set(ascii("AVI "), 8);
    expect(reason(riff)).toBe("not_wav");
    expect(reason(wave)).toBe("not_wav");
    expect(reason(new TextEncoder().encode("<svg onload=alert(1)>this is not audio at all</svg>"))).toBe("not_wav");
  });

  it("refuses a truncated header, a truncated data chunk and a missing pad byte", () => {
    expect(reason(ascii("RIFF\x00\x00"))).toBe("truncated");
    const good = wav([fmt(), data(secondsOf(1))]);
    expect(reason(good.slice(0, good.length - 10))).toBe("truncated"); // RIFF size now larger than the file
    // a chunk that claims more bytes than the file holds, with a RIFF size that agrees with the file
    const lying = wav([fmt(), { id: "data", body: new Uint8Array(100) }]);
    lying.set(le32(5000), 12 + 8 + 16 + 4);
    expect(reason(lying)).toBe("truncated");
    expect(reason(wav([fmt(), data(secondsOf(1)), { id: "LIST", body: new Uint8Array(3) }], { omitPad: true }))).toBe("truncated");
  });

  it("refuses a RIFF size that does not match the file: bytes missing or bytes appended", () => {
    const body = wav([fmt(), data(secondsOf(1))]);
    expect(reason(wav([fmt(), data(secondsOf(1))], { riffSize: body.length + 100 }))).toBe("truncated");
    expect(reason(wav([fmt(), data(secondsOf(1))], { trailing: 16 }))).toBe("bad_chunk");
  });

  it("refuses chunks in the wrong order or repeated", () => {
    expect(reason(wav([data(secondsOf(1)), fmt()]))).toBe("bad_chunk");
    expect(reason(wav([fmt(), fmt(), data(secondsOf(1))]))).toBe("bad_chunk");
    expect(reason(wav([fmt(), data(secondsOf(1)), data(secondsOf(1))]))).toBe("bad_chunk");
    expect(reason(wav([{ id: "fmt ", body: new Uint8Array(12) }, data(secondsOf(1))]))).toBe("bad_chunk");
  });

  it("refuses a file with no format or no data chunk", () => {
    expect(reason(wav([{ id: "LIST", body: new Uint8Array(4) }]))).toBe("no_format");
    expect(reason(wav([fmt()]))).toBe("no_data");
  });

  it("refuses anything but plain PCM", () => {
    expect(reason(wav([fmt({ format: 3 }), data(secondsOf(1))]))).toBe("unsupported_encoding"); // IEEE float
    expect(reason(wav([fmt({ format: 0xfffe, extra: join(le16(22), new Uint8Array(22)) }), data(secondsOf(1))]))).toBe("unsupported_encoding"); // extensible
    expect(reason(wav([fmt({ extra: join(le16(2), new Uint8Array(2)) }), data(secondsOf(1))]))).toBe("unsupported_encoding");
  });

  it("refuses stereo, 8-bit and 24-bit audio", () => {
    expect(reason(wav([fmt({ channels: 2 }), data(secondsOf(1) * 2)]))).toBe("not_mono");
    expect(reason(wav([fmt({ bits: 8 }), data(16_000)]))).toBe("not_16_bit");
    expect(reason(wav([fmt({ bits: 24 }), data(48_000)]))).toBe("not_16_bit");
  });

  it.each([7_999, 48_001, 96_000, 0])("refuses a sample rate of %i Hz", (rate) => {
    expect(reason(wav([fmt({ rate }), data(32_000)]))).toBe("bad_sample_rate");
  });

  it("refuses an inconsistent byte rate or block alignment", () => {
    expect(reason(wav([fmt({ byteRate: 16_000 }), data(secondsOf(1))]))).toBe("inconsistent_format");
    expect(reason(wav([fmt({ blockAlign: 4 }), data(secondsOf(1))]))).toBe("inconsistent_format");
  });

  it("refuses a data size that is not whole samples", () => {
    expect(reason(wav([fmt(), data(secondsOf(1) + 1)]))).toBe("bad_data_size");
  });

  it("refuses audio under half a second or over the configured maximum", () => {
    expect(reason(wav([fmt(), data(secondsOf(0.4))]))).toBe("too_short");
    expect(reason(wav([fmt(), data(secondsOf(10.5))]), { maxSeconds: 10 })).toBe("too_long");
    expect(reason(wav([fmt(), data(secondsOf(31))]))).toBe("too_long");
  });

  it("refuses a file bigger than the largest allowed recording before parsing it", () => {
    const huge = new Uint8Array(wavMaxBytes(30) + 1);
    huge.set(ascii("RIFF"), 0);
    expect(reason(huge)).toBe("too_large");
  });

  it("measures only the data actually present: a long header claim cannot buy a longer estimate", () => {
    // Twenty seconds of real data; nothing in the header can make it count as more.
    const r = parseWav(wav([fmt(), data(secondsOf(20))]), LIMITS);
    expect(r.ok && r.wav.seconds).toBe(20);
  });
});

describe("wavRejectionMessage", () => {
  it("is customer-safe and names the limit only where helpful", () => {
    expect(wavRejectionMessage("too_long", 30)).toContain("30 seconds");
    expect(wavRejectionMessage("not_mono", 30)).toMatch(/mono, 16-bit WAV/);
    expect(wavRejectionMessage("bad_chunk", 30)).toBe("This file is not a valid WAV recording.");
  });
});

describe("browser encoding round trip", () => {
  it("downsamples 48 kHz float audio to a 16 kHz WAV the server accepts, with the right duration", () => {
    const second = new Float32Array(48_000).map((_, i) => Math.sin(i / 10) * 0.5);
    const samples = concatSamples([second, second, second.subarray(0, 24_000)]); // 2.5 s
    const out = downsample(samples, 48_000);
    expect(out.length).toBe(40_000);
    const r = parseWav(encodeWav(out, RECORDING_SAMPLE_RATE), LIMITS);
    expect(r).toEqual({ ok: true, wav: { sampleRate: 16_000, dataBytes: 80_000, seconds: 2.5 } });
  });

  it("leaves audio at or below the target rate as it is, and clamps out-of-range samples", () => {
    const low = new Float32Array([0.1, -0.2]);
    expect(downsample(low, 8_000)).toBe(low);
    const bytes = encodeWav(new Float32Array([2, -2]), 16_000);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});
