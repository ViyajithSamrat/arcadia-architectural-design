import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // "server-only" throws outside the Next.js server build; tests run on the server side.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/db/**/*.test.ts"],
    // Makes any accidental live provider call fail loudly: default test runs never use the network.
    setupFiles: ["tests/unit/support/no-network.ts"],
    // Database tests start an in-process Postgres and apply every migration.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
