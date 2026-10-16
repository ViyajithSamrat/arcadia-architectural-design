import { parseEnv } from "@/lib/env/schema";
import { getIntegrationStatuses, type IntegrationStatus } from "./status";

/**
 * Overall application status, safe to expose.
 * Contains variable NAMES and yes/no states only. Never a value.
 */
export type AppStatus = {
  configValid: boolean;
  /** Names of variables whose provided value has an invalid format. */
  invalidVariables: string[];
  integrations: IntegrationStatus[];
};

export function buildAppStatus(raw: Record<string, string | undefined>): AppStatus {
  const parsed = parseEnv(raw);
  return {
    configValid: parsed.ok,
    invalidVariables: parsed.ok ? [] : parsed.issues.map((issue) => issue.name),
    integrations: getIntegrationStatuses(raw),
  };
}
