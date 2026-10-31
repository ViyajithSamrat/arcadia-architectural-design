import type { ReactNode } from "react";
import { NavLinks, type NavItem } from "@/components/layout/nav-links";

/**
 * Administrator navigation. These links are conveniences only: every administrator page and
 * action checks the role on the server (getAdminAccess / requireAdmin) and the database
 * policies apply, so showing a link grants nothing.
 */
const ADMIN_NAV: readonly NavItem[] = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/payments", label: "Payments" },
  { href: "/admin/generation", label: "Generation" },
  { href: "/admin/pricing", label: "Pricing" },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-2 border-b border-border-strong">
        <p className="eyebrow py-3">Administration</p>
        <nav aria-label="Administration" className="-mb-px max-w-full overflow-x-auto">
          <NavLinks
            items={ADMIN_NAV}
            className="flex gap-6"
            linkClassName="inline-flex min-h-12 items-center whitespace-nowrap border-b-2 border-transparent text-sm font-semibold text-muted transition-colors duration-300 hover:text-foreground aria-[current=page]:border-accent aria-[current=page]:text-foreground"
          />
        </nav>
      </div>
      {children}
    </div>
  );
}
