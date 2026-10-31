import { AuthNav } from "./auth-nav";
import { Wordmark } from "./brand";
import { MobileMenu, NavLinks, type NavItem } from "./nav-links";

/**
 * Application navigation (04_UI_UX.md section 4.2). Every link points at a page that exists.
 * The administrator link sits in the account area and appears only when the database says the
 * account is an administrator; it is a convenience, not authorization: each admin route checks
 * on the server. The account area is rendered once for every screen size (one session lookup).
 */
const NAV_ITEMS: readonly NavItem[] = [
  { href: "/new/empty-plot", label: "New build" },
  { href: "/new/interior", label: "Interiors" },
  { href: "/new/landscape", label: "Landscapes" },
  { href: "/projects", label: "My projects" },
];

const link =
  "relative inline-flex min-h-11 items-center text-sm font-medium text-foreground/80 transition-colors duration-300 hover:text-foreground after:absolute after:inset-x-0 after:bottom-2 after:h-px after:origin-left after:scale-x-0 after:bg-current after:transition-transform after:duration-300 hover:after:scale-x-100 aria-[current=page]:text-foreground aria-[current=page]:after:scale-x-100";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-limestone/90 backdrop-blur-md print:static print:hidden">
      <div className="mx-auto flex h-[4.5rem] w-full max-w-7xl items-center justify-between gap-4 px-4 sm:gap-6 sm:px-8">
        <Wordmark />
        <nav aria-label="Main" className="hidden md:block">
          <NavLinks items={NAV_ITEMS} className="flex items-center gap-7" linkClassName={link} />
        </nav>
        <div className="flex items-center gap-2 sm:gap-3">
          <AuthNav
            className="inline-flex min-h-11 items-center whitespace-nowrap rounded-[3px] border border-border-strong px-3 text-sm font-semibold transition-colors duration-300 hover:border-foreground hover:bg-paper sm:px-4"
            accountClassName="hidden max-w-[13rem] truncate text-sm text-muted xl:inline"
            tagClassName="rounded-[3px] bg-accent px-2 py-1 text-[0.6875rem] font-bold uppercase tracking-[0.14em] text-accent-contrast"
          />
          <MobileMenu>
            <nav aria-label="Main (small screens)">
              <NavLinks items={NAV_ITEMS} className="space-y-1" linkClassName={`${link} w-full text-base`} />
            </nav>
          </MobileMenu>
        </div>
      </div>
    </header>
  );
}
