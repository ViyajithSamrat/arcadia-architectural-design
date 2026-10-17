import { describe, expect, it } from "vitest";
import { buildObjectPath, newObjectName, parseObjectPath } from "@/lib/storage/paths";

const ID = "3f2b8c1e-5a4d-4c2e-9b1a-0d6e7f8a9b0c";

describe("storage paths", () => {
  it("builds and parses <project>/<kind>/<file>", () => {
    const path = buildObjectPath(ID, "payment-proofs", "a1.png");
    expect(path).toBe(`${ID}/payment-proofs/a1.png`);
    expect(parseObjectPath(path)).toEqual({ projectId: ID, kind: "payment-proofs", fileName: "a1.png" });
  });

  it("rejects traversal, wrong shapes and unknown kinds", () => {
    expect(() => buildObjectPath("not-a-uuid", "references", "a.png")).toThrow();
    expect(() => buildObjectPath(ID, "references", "../x.png")).toThrow();
    expect(() => buildObjectPath(ID, "references", "a/b.png")).toThrow();
    expect(() => buildObjectPath(ID, "other" as never, "a.png")).toThrow();
    expect(parseObjectPath(`${ID}/references/../../x`)).toBeNull();
    expect(parseObjectPath(`${ID}/references`)).toBeNull();
    expect(parseObjectPath(`${ID}/secrets/a.png`)).toBeNull();
  });

  it("makes random names with a validated extension", () => {
    const a = newObjectName(".PNG");
    expect(a).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(newObjectName("png")).not.toBe(a);
    expect(() => newObjectName("p/ng")).toThrow();
  });
});
