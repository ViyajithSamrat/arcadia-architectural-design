"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Notice } from "@/components/journey/notice";
import { SIGNED_IN_PARAM, safeNextPath } from "@/lib/auth/next-path";

/**
 * Sign in and sign out for the site headers. These are conveniences only: every page, route and
 * database policy checks the session itself.
 */

/** A link to /sign-in that brings the visitor back to the current application page afterwards. */
export function SignInLink({ className, children = "Sign in" }: { className?: string; children?: React.ReactNode }) {
  const pathname = usePathname();
  const next = safeNextPath(pathname);
  return (
    <Link href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"} className={className}>
      {children}
    </Link>
  );
}

/** Ends the session through the existing same-origin sign-out route, then goes to the home page. */
export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch("/api/auth/sign-out", { method: "POST" });
      if (!res.ok) throw new Error("sign-out failed");
      // Refreshed, so no cached page keeps showing what the signed-in account could see.
      router.replace("/");
      router.refresh();
    } catch {
      setPending(false);
      setFailed(true);
    }
  }

  return (
    <button type="button" onClick={signOut} disabled={pending} aria-busy={pending} className={className}>
      {pending ? "Signing out…" : failed ? "Sign out (try again)" : "Sign out"}
    </button>
  );
}

/**
 * The one-time confirmation after signing in. The sign-in routes and the callback add the marker;
 * the server renders this only when a session exists, so the marker alone shows nothing.
 * The marker is then removed from the address bar so a reload does not repeat it.
 */
export function JustSignedInNotice({ email }: { email: string | null }) {
  const params = useSearchParams();
  // Kept from the first render: removing the marker below updates useSearchParams.
  const [show] = useState(() => params.get(SIGNED_IN_PARAM) === "1");

  useEffect(() => {
    if (!show) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(SIGNED_IN_PARAM);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [show]);

  if (!show) return null;
  return (
    <div className="mb-6">
      <Notice tone="success" title="You are signed in" role="status">
        <p>{email ? `Signed in as ${email}.` : "Your session is active."}</p>
      </Notice>
    </div>
  );
}
