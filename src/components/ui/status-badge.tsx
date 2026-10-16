import type { IntegrationState } from "@/lib/integrations/status";

const LABELS: Record<IntegrationState, { text: string; symbol: string }> = {
  not_configured: { text: "Not configured", symbol: "â—‹" },
  partial: { text: "Partly configured", symbol: "â—" },
  configured_unverified: { text: "Configured, not yet verified", symbol: "â—" },
};

/**
 * Shows an integration state with text AND a symbol, so meaning never depends
 * on colour alone (04_UI_UX.md accessibility).
 */
export function StatusBadge({ state }: { state: IntegrationState }) {
  const { text, symbol } = LABELS[state];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm font-medium">
      <span aria-hidden="true">{symbol}</span>
      {text}
    </span>
  );
}
