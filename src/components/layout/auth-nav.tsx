import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getAccountSummary, type AccountSummary } from "@/lib/auth/session";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { JustSignedInNotice, SignInLink, SignOutButton } from "./auth-controls";

type Classes = { className?: string; accountClassName?: string; tagClassName?: string };

/**
 * The signed-in account's email, an Admin tag (a link to the admin overview) when the database says
 * so, and Sign out; or Sign in. The link is a convenience: every admin page checks the role itself.
 */
export function AccountNav({ account, className, accountClassName, tagClassName }: Classes & { account: AccountSummary | null }) {
  if (!account) return <SignInLink className={className} />;
  return (
    <>
      <span className={accountClassName} title={account.email ?? undefined}>
        <span className="sr-only">Signed in as </span>
        {account.email ?? "Signed in"}
      </span>
      {account.isAdmin ? (
        <Link href="/admin" title="Admin overview" className="inline-flex min-h-10 items-center">
          <span className={tagClassName}>Admin</span>
        </Link>
      ) : null}
      <SignOutButton className={className} />
    </>
  );
}

/** Decided from the session cookie on the server, checked with the Auth server. */
async function AuthNavContent(props: Classes) {
  // The session is per-request; see getPageAccess for why this comes first.
  await connection();
  if (!getSupabasePublicConfig()) return null;
  return <AccountNav account={await getAccountSummary()} {...props} />;
}

export function AuthNav(props: Classes) {
  return (
    <Suspense fallback={<span className={props.className} aria-hidden="true" />}>
      <AuthNavContent {...props} />
    </Suspense>
  );
}

/** "You are signed in" after signing in, only when a session really exists on the server. */
async function SignedInNoticeContent() {
  await connection();
  if (!getSupabasePublicConfig()) return null;
  const account = await getAccountSummary();
  return account ? <JustSignedInNotice email={account.email} /> : null;
}

export function SignedInNotice() {
  return (
    <Suspense fallback={null}>
      <SignedInNoticeContent />
    </Suspense>
  );
}
