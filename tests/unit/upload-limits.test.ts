import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVIDENCE_MAX_BYTES, EVIDENCE_REQUEST_MAX_BYTES } from "@/lib/payments/evidence";
import { REFERENCE_MAX_BYTES, REFERENCE_REQUEST_MAX_BYTES } from "@/lib/references/service";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_LABEL, UPLOAD_REQUEST_MAX_BYTES } from "@/lib/uploads/limits";

/** Vercel Functions refuse request bodies above 4.5 MB (decimal). */
const VERCEL_REQUEST_BODY_LIMIT = 4_500_000;
/** The private bucket limit set by migration 20261018000100_payment_proof_limits.sql. */
const BUCKET_LIMIT = 5 * 1024 * 1024;

describe("upload limits on the request path", () => {
  it("are 4 MiB per file, with the label used in messages", () => {
    expect(UPLOAD_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(UPLOAD_MAX_LABEL).toBe("4 MB");
  });

  it("keep the largest accepted request under Vercel's body limit and the file under the bucket limit", () => {
    expect(UPLOAD_REQUEST_MAX_BYTES).toBeLessThan(VERCEL_REQUEST_BODY_LIMIT);
    expect(UPLOAD_MAX_BYTES).toBeLessThan(BUCKET_LIMIT);
  });

  it("are the single source for payment evidence and reference photos", () => {
    expect(EVIDENCE_MAX_BYTES).toBe(UPLOAD_MAX_BYTES);
    expect(REFERENCE_MAX_BYTES).toBe(UPLOAD_MAX_BYTES);
    expect(EVIDENCE_REQUEST_MAX_BYTES).toBe(UPLOAD_REQUEST_MAX_BYTES);
    expect(REFERENCE_REQUEST_MAX_BYTES).toBe(UPLOAD_REQUEST_MAX_BYTES);
  });

  it.each(["src/components/payments/payment-form.tsx", "src/components/journey/reference-uploads.tsx"])(
    "%s uses the shared limit, not its own number",
    (file) => {
      const source = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), "utf8");
      expect(source).toContain("UPLOAD_MAX_BYTES");
      expect(source).not.toMatch(/\d\s*\*\s*1024\s*\*\s*1024/);
      expect(source).not.toMatch(/\b5 MB\b/);
    },
  );
});
