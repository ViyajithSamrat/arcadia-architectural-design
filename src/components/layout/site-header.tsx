import Link from "next/link";

/**
 * Customer navigation (04_UI_UX.md section 4.2). Every link points at a page that
 * exists. Administrator links are added in the administrator phase and, when they are,
 * will not be rendered as proof of authorization: each admin route checks on the server.
 */
const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/new/empty-plot", label: "New build" },
  { href: "/new/interior", label: "Interior design" },
  { href: "/new/landscape", label: "Landscaping" },
  { href: "/projects", label: "My projects" },
] as const;

export function SiteHeader() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
        <Link href="/" className="font-display text-xl font-medium tracking-tight">
          Architectural AI Design
        </Link>
        <nav aria-label="Main">
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="inline-block py-1 underline-offset-4 hover:underline">
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
