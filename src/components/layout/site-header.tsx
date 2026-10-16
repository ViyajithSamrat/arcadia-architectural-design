import Link from "next/link";

/**
 * Site header. Phase 1 shows only routes that exist. The customer journey
 * links (New Build, Interior, Landscaping, My Projects) are added when those
 * pages are built, so the navigation never points at something that is not real.
 */
const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/status", label: "System status" },
] as const;

export function SiteHeader() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Architectural AI Design
        </Link>
        <nav aria-label="Main">
          <ul className="flex items-center gap-5 text-sm">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="underline-offset-4 hover:underline">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
