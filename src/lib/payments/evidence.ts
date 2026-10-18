import { minorToDecimal } from "@/lib/journeys/money";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/db/schema";

/**
 * Validation of what a customer submits as payment evidence. Everything here is a claim
 * to be reviewed by a person; nothing in this file decides whether a payment happened.
 *
 * The file limits match the bucket restriction in
 * supabase/migrations/20261018000100_payment_proof_limits.sql. Keep the two in step.
 */

export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
/** Room for the multipart framing around a file of the maximum size. */
export const EVIDENCE_REQUEST_MAX_BYTES = EVIDENCE_MAX_BYTES + 64 * 1024;

export const EVIDENCE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type EvidenceMime = keyof typeof EVIDENCE_TYPES;

export type SniffedImage = { mime: EvidenceMime; ext: (typeof EVIDENCE_TYPES)[EvidenceMime] };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

/**
 * The real type of a file from its first bytes. The file name and the browser's declared
 * type are never used: both are chosen by the sender.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  // WebP: "RIFF" <4 byte size> "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

export type FileCheck = { ok: true; image: SniffedImage; bytes: Uint8Array } | { ok: false; message: string };

/** Checks size first (so an oversized file is never read) and then the real type. */
export async function checkEvidenceFile(file: { size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<FileCheck> {
  if (file.size > EVIDENCE_MAX_BYTES) return { ok: false, message: "The image is larger than 5 MB. Choose a smaller one." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) return { ok: false, message: "The image is empty. Choose another file." };
  if (bytes.length > EVIDENCE_MAX_BYTES) return { ok: false, message: "The image is larger than 5 MB. Choose a smaller one." };
  const image = sniffImage(bytes);
  if (!image) return { ok: false, message: "Use a JPEG, PNG or WebP image." };
  return { ok: true, image, bytes };
}

// ---------------------------------------------------------------------------
// Text fields
// ---------------------------------------------------------------------------

export type RawEvidenceFields = { utrReference?: unknown; transferDate?: unknown; amount?: unknown; method?: unknown };

export type EvidenceFields = {
  utrReference: string;
  /** YYYY-MM-DD */
  transferDate: string;
  /** Decimal string for a numeric(12,2) column, for example "1234.50". */
  amountClaimed: string;
  method: PaymentMethod;
};

export type FieldsResult = { ok: true; value: EvidenceFields } | { ok: false; fieldErrors: Record<string, string> };

const UTR = /^[A-Za-z0-9-]{6,40}$/;
const DAY = 24 * 60 * 60 * 1000;

function parseDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? ms : null;
}

/** "1234.5" -> 123450 minor units. Rejects signs, exponents, more than two decimals and zero. */
export function parseAmountToMinor(value: string): number | null {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return minor > 0 ? minor : null;
}

/**
 * @param acceptedAt when the quote was accepted: payment instructions only appear after that,
 *   so a transfer dated earlier (allowing a day for time zones) cannot be for this quote
 */
export function parseEvidenceFields(raw: RawEvidenceFields, context: { now: Date; acceptedAt: string | null }): FieldsResult {
  const fieldErrors: Record<string, string> = {};
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const utrReference = str(raw.utrReference);
  if (!UTR.test(utrReference)) fieldErrors.utrReference = "Enter the transfer reference (6 to 40 letters, numbers or hyphens).";

  const dateText = str(raw.transferDate);
  const day = parseDay(dateText);
  if (day === null) {
    fieldErrors.transferDate = "Enter the transfer date.";
  } else {
    const today = Date.UTC(context.now.getUTCFullYear(), context.now.getUTCMonth(), context.now.getUTCDate());
    const accepted = context.acceptedAt ? new Date(context.acceptedAt) : null;
    const acceptedDay = accepted && !Number.isNaN(accepted.getTime()) ? Date.UTC(accepted.getUTCFullYear(), accepted.getUTCMonth(), accepted.getUTCDate()) : null;
    if (day > today + DAY) fieldErrors.transferDate = "The transfer date cannot be in the future.";
    else if (acceptedDay !== null && day < acceptedDay - DAY) fieldErrors.transferDate = "The transfer date is before you accepted the quote.";
  }

  const minor = parseAmountToMinor(str(raw.amount));
  if (minor === null) fieldErrors.amount = "Enter the amount you transferred, for example 12500.00.";

  const method = str(raw.method);
  if (!(PAYMENT_METHODS as readonly string[]).includes(method)) fieldErrors.method = "Choose UPI or net banking.";

  if (Object.keys(fieldErrors).length > 0 || minor === null) return { ok: false, fieldErrors };
  return {
    ok: true,
    value: { utrReference, transferDate: dateText, amountClaimed: minorToDecimal(minor), method: method as PaymentMethod },
  };
}

// ---------------------------------------------------------------------------
// Administrator decision text
// ---------------------------------------------------------------------------

export const REASON_MAX = 500;
export const NOTE_MAX = 500;

/** Trimmed text within a length limit, or null when it is longer. Empty becomes "". */
export function limitedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? null : trimmed;
}
