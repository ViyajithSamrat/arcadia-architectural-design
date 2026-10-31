import type { ReactNode } from "react";
import { SignedInNotice } from "@/components/layout/auth-nav";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";

/** Chrome for every application page (journeys, projects, sign-in, status, admin). */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[3px] focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-contrast"
      >
        Skip to main content
      </a>
      <SiteHeader />
      <main id="main" className="gn-rise mx-auto w-full max-w-7xl flex-1 px-5 pb-20 pt-10 sm:px-8 sm:pt-14">
        <SignedInNotice />
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
