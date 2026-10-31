import { describe, expect, it } from "vitest";
import { buildAppStatus } from "@/lib/integrations/app-status";
import { getIntegrationStatuses } from "@/lib/integrations/status";

const byId = (env: Record<string, string | undefined>) =>
  Object.fromEntries(getIntegrationStatuses(env).map((s) => [s.id, s]));

describe("getIntegrationStatuses", () => {
  it("reports every integration as not configured when nothing is set", () => {
    const all = getIntegrationStatuses({});
    expect(all.map((s) => s.id).sort()).toEqual(["gnani", "openrouter", "payment_display", "readback_audio", "supabase", "voice_input"]);
    for (const status of all) {
      expect(status.state).toBe("not_configured");
      expect(status.message).toContain("Not configured");
    }
  });

  it("reports a partly set integration as partial and names what is missing", () => {
    const status = byId({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" }).supabase;
    expect(status.state).toBe("partial");
    expect(status.missing).toEqual(["NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
  });

  it("never says an integration works: complete settings are only 'configured, not verified'", () => {
    const status = byId({ GNANI_API_KEY: "key" }).gnani;
    expect(status.state).toBe("configured_unverified");
    expect(status.message).toMatch(/does not confirm the service works/i);
  });

  it("treats the payment display group as satisfied by either variable", () => {
    expect(byId({ PAYMENT_UPI_ID: "x@y" }).payment_display.state).toBe("configured_unverified");
    expect(byId({ PAYMENT_INSTRUCTIONS: "Pay by transfer" }).payment_display.state).toBe("configured_unverified");
    expect(byId({}).payment_display.missing[0]).toContain("PAYMENT_UPI_ID");
  });

  it("never includes a secret value anywhere in the output", () => {
    const secrets = {
      OPENROUTER_API_KEY: "sk-or-TOPSECRET-1111",
      OPENROUTER_TEXT_MODEL: "model-TOPSECRET-2222",
      GNANI_API_KEY: "gnani-TOPSECRET-3333",
      NEXT_PUBLIC_SUPABASE_URL: "https://TOPSECRET-4444.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-TOPSECRET-5555",
    };
    expect(JSON.stringify(getIntegrationStatuses(secrets))).not.toContain("TOPSECRET");
    expect(JSON.stringify(buildAppStatus(secrets))).not.toContain("TOPSECRET");
  });
});

describe("buildAppStatus", () => {
  it("is valid with no invalid variables for an empty environment", () => {
    expect(buildAppStatus({})).toMatchObject({ configValid: true, invalidVariables: [] });
  });

  it("flags only the variable name when a URL is malformed", () => {
    const status = buildAppStatus({ NEXT_PUBLIC_APP_URL: "not a url" });
    expect(status.configValid).toBe(false);
    expect(status.invalidVariables).toEqual(["NEXT_PUBLIC_APP_URL"]);
  });
});

describe("voice input status (it must match what the transcribe route will do)", () => {
  const LIVE = {
    GNANI_VOICE_ENABLED: "true",
    GNANI_API_KEY: "gnani-TOPSECRET-3333",
    GNANI_BASE_URL: "https://api.vachana.ai",
    GNANI_STT_ENDPOINT: "/stt/v3",
    GNANI_LANGUAGES: "ta-IN",
    GNANI_CREDITS_PER_STT_SECOND: "2",
    GNANI_MAX_CREDITS_PER_REQUEST: "100",
    GNANI_CUSTOMER_CREDITS_PER_HOUR: "300",
    GNANI_BUDGET_CREDITS: "1000",
    VOICE_TRANSCRIPT_SECRET: "voice-TOPSECRET-signing-secret-0123456789",
  };

  it("an API key alone does not mean voice input works", () => {
    const status = byId({ GNANI_API_KEY: "gnani-TOPSECRET-3333" });
    expect(status.gnani.message).toMatch(/A key alone does not switch voice input on/);
    expect(status.voice_input).toMatchObject({ state: "not_configured" });
  });

  it("reports the labelled mock as mock only", () => {
    expect(byId({ GNANI_VOICE_ENABLED: "mock" }).voice_input).toMatchObject({ state: "mock_only", message: expect.stringMatching(/MOCK transcriber/) });
  });

  it("reports an explicit false as off, not as an unrecognised value, and read-back stays unconfigured", () => {
    expect(byId({ GNANI_VOICE_ENABLED: "false" }).voice_input).toMatchObject({ state: "not_configured", message: expect.stringMatching(/Voice input is off/) });
    expect(byId({ GNANI_VOICE_ENABLED: "false" }).readback_audio.state).toBe("not_configured");
  });

  it("reports an unrecognised switch and an incomplete live setup as partial, naming settings only", () => {
    expect(byId({ GNANI_VOICE_ENABLED: "yes" }).voice_input.state).toBe("partial");
    const status = byId({ GNANI_VOICE_ENABLED: "true", GNANI_API_KEY: "gnani-TOPSECRET-3333" }).voice_input;
    expect(status.state).toBe("partial");
    expect(status.missing).toEqual(expect.arrayContaining([expect.stringContaining("GNANI_BASE_URL"), expect.stringContaining("VOICE_TRANSCRIPT_SECRET")]));
  });

  it("a complete live setup is shown as configured but unverified, never as working", () => {
    const status = byId(LIVE).voice_input;
    expect(status).toMatchObject({ state: "configured_unverified", missing: [] });
    expect(status.message).toMatch(/does not confirm the service works/);
    expect(status.message).toMatch(/not been verified against Gnani/);
    expect(JSON.stringify(getIntegrationStatuses(LIVE))).not.toContain("TOPSECRET");
    expect(JSON.stringify(buildAppStatus(LIVE))).not.toContain("TOPSECRET");
  });
});
