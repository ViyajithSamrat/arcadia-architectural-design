import { describe, expect, it } from "vitest";
import { buildAppStatus } from "@/lib/integrations/app-status";
import { getIntegrationStatuses } from "@/lib/integrations/status";

const byId = (env: Record<string, string | undefined>) =>
  Object.fromEntries(getIntegrationStatuses(env).map((s) => [s.id, s]));

describe("getIntegrationStatuses", () => {
  it("reports every integration as not configured when nothing is set", () => {
    const all = getIntegrationStatuses({});
    expect(all.map((s) => s.id).sort()).toEqual(["gnani", "openrouter", "payment_display", "supabase"]);
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
