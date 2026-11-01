import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("instrumentation-client", () => {
  it("turns Zod's eval-based parsers off, so no CSP 'unsafe-eval' violation is reported", async () => {
    await import("@/instrumentation-client");
    expect(z.config().jitless).toBe(true);

    let constructed = 0;
    const original = globalThis.Function;
    globalThis.Function = new Proxy(original, {
      construct(target, args) {
        constructed++;
        return Reflect.construct(target, args);
      },
    });
    try {
      const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }) });
      expect(schema.parse({ a: "x", b: { c: 1 } })).toEqual({ a: "x", b: { c: 1 } });
      expect(schema.safeParse({ a: 1 }).success).toBe(false);
    } finally {
      globalThis.Function = original;
    }
    expect(constructed).toBe(0);
  });
});
