/**
 * Browser-side WAV encoding for the voice recorder: no dependency, no server code.
 *
 * The microphone delivers 32-bit float samples at the audio device's rate (often 44.1 or
 * 48 kHz). They are averaged down to 16 kHz (a box filter, which also removes most content the
 * lower rate cannot represent) and written as mono 16-bit PCM in a 44-byte RIFF/WAVE header,
 * which is exactly what the server's strict parser accepts.
 */

export const RECORDING_SAMPLE_RATE = 16_000;

export function concatSamples(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Averages `input` down to `outputRate`. Input at or below the target rate is returned unchanged. */
export function downsample(input: Float32Array, inputRate: number, outputRate: number = RECORDING_SAMPLE_RATE): Float32Array {
  if (inputRate <= outputRate) return input;
  const ratio = inputRate / outputRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Seconds of audio in a WAV made by encodeWav (its fixed 44-byte header); 0 when there is none. */
export function encodedSeconds(wav: Uint8Array): number {
  if (wav.length < 44) return 0;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const byteRate = view.getUint32(28, true);
  return byteRate > 0 ? view.getUint32(40, true) / byteRate : 0;
}

/** Mono 16-bit PCM WAV. Samples are clamped to [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return bytes;
}
