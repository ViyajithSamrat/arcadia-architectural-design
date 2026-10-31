import Link from "next/link";

/** The GNANI wordmark: the name in the display serif, the practice in small tracked capitals. */
export function Wordmark({ tone = "dark", href = "/" }: { tone?: "dark" | "light"; href?: string }) {
  const sub = tone === "light" ? "text-white/70" : "text-muted";
  return (
    <Link href={href} className="group inline-flex items-baseline gap-3" aria-label="GNANI Architectural AI, home">
      <span className="font-display text-[1.75rem] font-semibold leading-none tracking-[0.18em]">GNANI</span>
      <span aria-hidden="true" className={`hidden text-[0.6875rem] font-semibold uppercase tracking-[0.2em] sm:inline ${sub}`}>
        Architectural AI
      </span>
    </Link>
  );
}
