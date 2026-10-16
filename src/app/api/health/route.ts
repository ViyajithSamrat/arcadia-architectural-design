import { connection } from "next/server";
import { buildAppStatus } from "@/lib/integrations/app-status";

/**
 * GET /api/health
 * Reports whether the app is running and which optional services have their
 * settings present. Returns variable NAMES and states only: no secret values,
 * no URLs, no raw environment content.
 *
 * `connection()` makes this read the environment at request time instead of
 * baking build-time values into a prerendered response (Cache Components).
 */
export async function GET() {
  await connection();

  const requestId = crypto.randomUUID();
  const status = buildAppStatus(process.env);

  return Response.json(
    {
      status: status.configValid ? "ok" : "degraded",
      requestId,
      configValid: status.configValid,
      invalidVariables: status.invalidVariables,
      integrations: status.integrations.map((integration) => ({
        id: integration.id,
        state: integration.state,
        neededInPhase: integration.neededInPhase,
        missing: integration.missing,
      })),
    },
    { status: status.configValid ? 200 : 503 },
  );
}
