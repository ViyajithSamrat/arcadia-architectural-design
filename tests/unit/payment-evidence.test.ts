import { describe, expect, it } from "vitest";
import { getPaymentDisplay } from "@/lib/payments/config";
import {
  checkEvidenceFile,
  EVIDENCE_MAX_BYTES,
  limitedText,
  parseAmountToMinor,
  parseEvidenceFields,
  sniffImage,
} from "@/lib/payments/evidence";

const bytes = (...values: number[]) => new Uint8Array(values);
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];
const fileOf = (data: Uint8Array, size = data.length) => ({ size, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer });

describe("sniffImage (type comes from the bytes, never the name)", () => {
  it("recognises JPEG, PNG and WebP", () => {
    expect(sniffImage(bytes(...JPEG))).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(sniffImage(bytes(...PNG))).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffImage(bytes(...WEBP))).toEqual({ mime: "image/webp", ext: "webp" });
  });

  it.each([
    ["GIF", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ["PDF", [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ["SVG text", Array.from(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))],
    ["HTML", Array.from(new TextEncoder().encode("<script>alert(1)</script>"))],
    ["RIFF but not WebP (WAV)", [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]],
    ["truncated PNG signature", PNG.slice(0, 5)],
    ["empty", []],
  ])("rejects %s", (_name, data) => {
    expect(sniffImage(bytes(...data))).toBeNull();
  });
});

describe("checkEvidenceFile", () => {
  it("accepts a small real image and returns the detected type and bytes", async () => {
    const result = await checkEvidenceFile(fileOf(bytes(...PNG)));
    expect(result).toMatchObject({ ok: true, image: { mime: "image/png", ext: "png" } });
  });

  it("refuses an oversized file without reading it", async () => {
    let read = false;
    const huge = { size: EVIDENCE_MAX_BYTES + 1, arrayBuffer: async () => ((read = true), new ArrayBuffer(0)) };
    expect(await checkEvidenceFile(huge)).toMatchObject({ ok: false });
    expect(read).toBe(false);
  });

  it("accepts a file of exactly the maximum size", async () => {
    const data = new Uint8Array(EVIDENCE_MAX_BYTES);
    data.set(PNG);
    expect(await checkEvidenceFile(fileOf(data))).toMatchObject({ ok: true });
  });

  it("refuses a file that claims to be small but is larger", async () => {
    const data = new Uint8Array(EVIDENCE_MAX_BYTES + 1);
    data.set(PNG);
    expect(await checkEvidenceFile(fileOf(data, 10))).toMatchObject({ ok: false });
  });

  it("refuses empty and disguised files", async () => {
    expect(await checkEvidenceFile(fileOf(new Uint8Array(0)))).toMatchObject({ ok: false });
    expect(await checkEvidenceFile(fileOf(new TextEncoder().encode("MZ not an image")))).toMatchObject({ ok: false, message: "Use a JPEG, PNG or WebP image." });
  });
});

describe("parseAmountToMinor", () => {
  it.each([
    ["12500", 1250000],
    ["12500.5", 1250050],
    ["12500.50", 1250050],
    ["0.01", 1],
    [" 99.99 ", 9999],
  ])("%s -> %i", (input, expected) => expect(parseAmountToMinor(input)).toBe(expected));

  it.each(["", "0", "0.00", "-5", "+5", "1e3", "12,500", "1.234", "abc", "12500.", ".5", "99999999999"])("rejects %j", (input) => {
    expect(parseAmountToMinor(input)).toBeNull();
  });
});

describe("parseEvidenceFields", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const acceptedAt = "2026-10-17T09:00:00Z";
  const good = { utrReference: "UTR123456789", transferDate: "2026-10-18", amount: "12500.00", method: "UPI" };
  const parse = (patch: Record<string, unknown> = {}, ctx = { now, acceptedAt: acceptedAt as string | null }) => parseEvidenceFields({ ...good, ...patch }, ctx);

  it("accepts valid fields and returns a decimal string for the database", () => {
    expect(parse()).toEqual({ ok: true, value: { utrReference: "UTR123456789", transferDate: "2026-10-18", amountClaimed: "12500.00", method: "UPI" } });
  });

  it("accepts net banking and trims whitespace", () => {
    expect(parse({ method: "NETBANKING", utrReference: "  AB-123456  " })).toMatchObject({ ok: true, value: { method: "NETBANKING", utrReference: "AB-123456" } });
  });

  it.each([
    ["short reference", { utrReference: "123" }, "utrReference"],
    ["reference with symbols", { utrReference: "ABC 123;DROP" }, "utrReference"],
    ["very long reference", { utrReference: "A".repeat(41) }, "utrReference"],
    ["missing date", { transferDate: "" }, "transferDate"],
    ["impossible date", { transferDate: "2026-02-31" }, "transferDate"],
    ["badly formatted date", { transferDate: "18/10/2026" }, "transferDate"],
    ["date in the future", { transferDate: "2026-10-25" }, "transferDate"],
    ["date before the quote was accepted", { transferDate: "2026-10-10" }, "transferDate"],
    ["zero amount", { amount: "0" }, "amount"],
    ["negative amount", { amount: "-100" }, "amount"],
    ["three decimals", { amount: "10.123" }, "amount"],
    ["unknown method", { method: "CASH" }, "method"],
    ["method as a number", { method: 1 }, "method"],
  ])("rejects %s", (_name, patch, field) => {
    const result = parse(patch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors)).toContain(field);
  });

  it("allows a transfer dated a day either side of the boundaries (time zones)", () => {
    expect(parse({ transferDate: "2026-10-19" }).ok).toBe(true);
    expect(parse({ transferDate: "2026-10-16" }).ok).toBe(true);
  });

  it("ignores any extra properties such as status or verified flags", () => {
    const result = parseEvidenceFields({ ...good, status: "VERIFIED", verified: true, isPaid: true } as never, { now, acceptedAt });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(Object.keys(result.value).sort()).toEqual(["amountClaimed", "method", "transferDate", "utrReference"]);
  });
});

describe("limitedText", () => {
  it("trims, treats non-strings as empty, and rejects over-long text", () => {
    expect(limitedText("  hi ", 10)).toBe("hi");
    expect(limitedText(undefined, 10)).toBe("");
    expect(limitedText("x".repeat(11), 10)).toBeNull();
  });
});

describe("getPaymentDisplay", () => {
  const ready = { PAYMENT_MODE: "manual", PAYMENT_UPI_ID: "pay@bank", PAYMENT_ACCOUNT_NAME: "Studio", PAYMENT_INSTRUCTIONS: "Use your own UPI app." };

  it("is ready with manual mode and payment details", () => {
    expect(getPaymentDisplay("INR", ready)).toEqual({ state: "ready", upiId: "pay@bank", accountName: "Studio", instructions: "Use your own UPI app.", isDemo: false });
  });

  it("is not configured with no values, a blank mode, another mode, or no details", () => {
    expect(getPaymentDisplay("INR", {})).toEqual({ state: "not_configured", reason: "mode" });
    expect(getPaymentDisplay("INR", { ...ready, PAYMENT_MODE: "  " })).toMatchObject({ state: "not_configured", reason: "mode" });
    expect(getPaymentDisplay("INR", { ...ready, PAYMENT_MODE: "gateway" })).toMatchObject({ state: "not_configured", reason: "mode" });
    expect(getPaymentDisplay("INR", { PAYMENT_MODE: "manual", PAYMENT_ACCOUNT_NAME: "Studio" })).toMatchObject({ state: "not_configured", reason: "details" });
  });

  it("is not configured when PAYMENT_CURRENCY differs from the quote currency", () => {
    expect(getPaymentDisplay("INR", { ...ready, PAYMENT_CURRENCY: "USD" })).toMatchObject({ state: "not_configured", reason: "currency" });
    expect(getPaymentDisplay("INR", { ...ready, PAYMENT_CURRENCY: "inr" })).toMatchObject({ state: "ready" });
  });

  it("marks demo values", () => {
    expect(getPaymentDisplay("INR", { ...ready, PAYMENT_INSTRUCTIONS: "DEMO — DO NOT TRANSFER MONEY." })).toMatchObject({ isDemo: true });
  });
});
