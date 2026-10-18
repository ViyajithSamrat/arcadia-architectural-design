import type { ReactNode } from "react";

type Tone = "info" | "warning" | "danger" | "success";

const TONES: Record<Tone, { box: string; symbol: string; word: string }> = {
  info: { box: "border-border bg-surface text-foreground", symbol: "ℹ", word: "Note" },
  warning: { box: "border-transparent bg-warning-bg text-warning-fg", symbol: "⚠", word: "Notice" },
  danger: { box: "border-transparent bg-danger-bg text-danger-fg", symbol: "✕", word: "Problem" },
  success: { box: "border-transparent bg-success-bg text-success-fg", symbol: "✓", word: "Done" },
};

/**
 * A boxed message. The symbol and the visually hidden word mean the tone is never
 * conveyed by colour alone.
 */
export function Notice({
  tone = "info",
  title,
  children,
  role,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  role?: "alert" | "status";
}) {
  const t = TONES[tone];
  return (
    <div role={role} className={`flex gap-3 rounded-lg border px-4 py-3 ${t.box}`}>
      <span aria-hidden="true" className="select-none">
        {t.symbol}
      </span>
      <div className="space-y-1">
        <p className="sr-only">{t.word}</p>
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className="space-y-1 text-sm">{children}</div>
      </div>
    </div>
  );
}
