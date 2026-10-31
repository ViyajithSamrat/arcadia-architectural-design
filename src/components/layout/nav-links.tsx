"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";

/** `exact`: current only on that page itself, not on the pages beneath it. */
export type NavItem = { href: string; label: string; exact?: boolean };

/** True when `pathname` is the item's page or one beneath it ("/" and exact items match only themselves). */
export function isCurrent(pathname: string | null, href: string, exact = false): boolean {
  if (!pathname) return false;
  if (href === "/" || exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

type LinksProps = { items: readonly NavItem[]; className?: string; linkClassName?: string };

function Links({ items, className, linkClassName, pathname }: LinksProps & { pathname: string | null }) {
  return (
    <ul className={className}>
      {items.map((item) => {
        const current = isCurrent(pathname, item.href, item.exact);
        return (
          <li key={item.href}>
            <Link href={item.href} aria-current={current ? "page" : undefined} className={linkClassName}>
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function CurrentLinks(props: LinksProps) {
  return <Links {...props} pathname={usePathname()} />;
}

/**
 * Navigation links that mark the page the visitor is on, in words for assistive technology and
 * with an underline on screen. The path is request data, so it is read inside a Suspense boundary;
 * the fallback is the same links without the mark.
 */
export function NavLinks(props: LinksProps) {
  return (
    <Suspense fallback={<Links {...props} pathname={null} />}>
      <CurrentLinks {...props} />
    </Suspense>
  );
}

type MenuProps = { children: ReactNode; label?: string };

function Menu({ children, label = "Menu" }: MenuProps) {
  return (
    <details className="group relative md:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-[3px] border border-border-strong px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="flex w-4 flex-col gap-[3px]">
          <span className="h-px w-full bg-current transition-transform duration-300 group-open:translate-y-[4px] group-open:rotate-45" />
          <span className="h-px w-full bg-current transition-opacity duration-300 group-open:opacity-0" />
          <span className="h-px w-full bg-current transition-transform duration-300 group-open:-translate-y-[4px] group-open:-rotate-45" />
        </span>
        {label}
      </summary>
      <div className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-[min(20rem,calc(100vw-2rem))] rounded-[4px] border border-border bg-paper p-5 shadow-lift">
        {children}
      </div>
    </details>
  );
}

/** Keyed by the path so the menu closes after each navigation. */
function KeyedMenu(props: MenuProps) {
  return <Menu key={usePathname()} {...props} />;
}

/** A disclosure menu for small screens. */
export function MobileMenu(props: MenuProps) {
  return (
    <Suspense fallback={<Menu {...props} />}>
      <KeyedMenu {...props} />
    </Suspense>
  );
}
