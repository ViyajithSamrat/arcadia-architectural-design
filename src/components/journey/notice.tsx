import type { ReactNode } from "react";

type Tone = "info" | "warning" | "danger" | "success";

const TONES: Record<Tone, { box: string; mark: string; symbol: string; word: string }> = {
  info: { box: "border-border bg-surface text-foreground", mark: "bg-sandstone", symbol: "ℹ", word: "Note" },
  warning: { box: "border-transparent bg-warning-bg text-warning-fg", mark: "bg-warning-fg", symbol: "⚠", word: "Notice" },
  danger: { box: "border-transparent bg-danger-bg text-danger-fg", mark: "bg-danger-fg", symbol: "✕", word: "Problem" },
  success: { box: "border-transparent bg-success-bg text-success-fg", mark: "bg-success-fg", symbol: "✓", word: "Done" },
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
    <div role={role} className={`relative flex gap-3 overflow-hidden rounded-[4px] border py-3.5 pl-5 pr-4 ${t.box}`}>
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${t.mark}`} />
      <span aria-hidden="true" className="select-none leading-6">
        {t.symbol}
      </span>
      <div className="min-w-0 space-y-1">
        <p className="sr-only">{t.word}</p>
        {title ? <p className="font-semibold leading-6">{title}</p> : null}
        <div className="space-y-1 text-sm leading-relaxed">{children}</div>
      </div>
    </div>
  );
}
