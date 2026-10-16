import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { buildAppStatus } from "@/lib/integrations/app-status";

export const metadata: Metadata = { title: "System status" };

/**
 * Reads the environment at request time (not build time) and shows only
 * variable NAMES and states. No value is ever rendered.
 */
async function StatusPanel() {
  await connection();
  const status = buildAppStatus(process.env);

  return (
    <div className="space-y-8">
      {status.configValid ? (
        <p>Configuration format check: no problems found.</p>
      ) : (
        <div role="alert" className="rounded-lg bg-warning-bg px-5 py-4 text-warning-fg">
          <p className="font-semibold">Some settings have an invalid format.</p>
          <p className="mt-1">
            Fix these variables in <code>.env.local</code>, then restart the server:{" "}
            {status.invalidVariables.join(", ")}.
          </p>
        </div>
      )}

      <ul className="space-y-4">
        {status.integrations.map((integration) => (
          <li key={integration.id} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{integration.label}</h2>
              <StatusBadge state={integration.state} />
            </div>
            <p className="mt-2 text-sm text-muted">{integration.message}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function StatusPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">System status</h1>
      <p className="max-w-2xl text-muted">
        Optional services are off until you add their settings. &ldquo;Configured&rdquo; only
        means the settings are present. It does not mean the service has been tested.
      </p>
      <Suspense fallback={<p>Checking configurationâ€¦</p>}>
        <StatusPanel />
      </Suspense>
    </div>
  );
}
