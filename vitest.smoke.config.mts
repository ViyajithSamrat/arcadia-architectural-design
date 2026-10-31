import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

/**
 * OPT-IN smoke tests against the REAL providers. Not part of `npm test`: the default suite blocks
 * the network. Each provider test skips itself unless its settings are present, and the whole file
 * skips unless LIVE_PROVIDER_SMOKE=1. They spend real credits, so run them only with the owner's
 * approval and synthetic data:
 *
 *   LIVE_PROVIDER_SMOKE=1 npx vitest run --config vitest.smoke.config.mts
 *
 * Reads .env.local through the same loader as the app. It never prints a secret.
 */
export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/provider-smoke/**/*.smoke.test.ts"],
    env: loadEnv(mode, process.cwd(), ""),
    testTimeout: 240_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
}));
