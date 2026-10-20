/**
 * Default test runs must never reach a live provider. Any test that wants to exercise a
 * provider adapter passes its own fake `fetch`; a call through the real one fails here.
 * (The opt-in live suites use vitest.live.config.mts, which does not load this file.)
 */
globalThis.fetch = (() => {
  throw new Error("Network access is blocked in default tests. Pass a fake fetch to the adapter.");
}) as typeof fetch;
