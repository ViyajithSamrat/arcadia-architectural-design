import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { getAccountSummary, type AccountSummary } from "@/lib/auth/session";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { JustSignedInNotice, SignInLink, SignOutButton } from "./auth-controls";

type Classes = { className?: string; accountClassName?: string; tagClassName?: string; createClassName?: string };

/**
 * What a visitor without a session sees: Sign in and, where the header gives it a style, Create
 * account. It is also the loading placeholder, so a visitor never waits on the session lookup to
 * find the way in (a signed-in visitor sees it only until the account area arrives).
 */
function SignedOutLinks({ className, createClassName }: Pick<Classes, "className" | "createClassName">) {
  return (
    <>
      <SignInLink className={className} />
      {createClassName ? (
        <SignInLink className={createClassName} signUp>
          Create account
        </SignInLink>
      ) : null}
    </>
  );
}

/**
 * The same links for the prerendered shell. They cannot read the current URL (request data is not
 * available while the page is built), so they do not carry a return path; the links that replace
 * them as soon as the session is known do.
 */
function PlainSignedOutLinks({ className, createClassName }: Pick<Classes, "className" | "createClassName">) {
  return (
    <>
      <Link href="/sign-in" className={className}>
        Sign in
      </Link>
      {createClassName ? (
        <Link href="/sign-in?mode=sign-up" className={createClassName}>
          Create account
        </Link>
      ) : null}
    </>
  );
}

/**
 * The signed-in account's email, an Admin tag (a link to the admin overview) when the database says
 * so, and Sign out; or Sign in. The link is a convenience: every admin page checks the role itself.
 */
export function AccountNav({ account, className, accountClassName, tagClassName, createClassName }: Classes & { account: AccountSummary | null }) {
  if (!account) return <SignedOutLinks className={className} createClassName={createClassName} />;
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
    <Suspense fallback={<PlainSignedOutLinks className={props.className} createClassName={props.createClassName} />}>
      <AuthNavContent {...props} />
    </Suspense>
  );
}

async function AuthMenuLinksContent({ children }: { children: ReactNode }) {
  await connection();
  if (!getSupabasePublicConfig()) return null;
  return (await getAccountSummary()) ? null : children;
}

/**
 * The same way in, inside the small-screen menu, for a visitor without a session only (a signed-in
 * visitor already has Sign out in the header). The links are also the placeholder while it loads.
 */
export function AuthMenuLinks({ linkClassName, createClassName }: { linkClassName?: string; createClassName?: string }) {
  const links = (
    <ul className="mt-3 space-y-2 border-t border-border pt-3">
      <li>
        <SignInLink className={linkClassName} />
      </li>
      <li>
        <SignInLink className={createClassName} signUp>
          Create account
        </SignInLink>
      </li>
    </ul>
  );
  const plain = (
    <ul className="mt-3 space-y-2 border-t border-border pt-3">
      <li>
        <Link href="/sign-in" className={linkClassName}>
          Sign in
        </Link>
      </li>
      <li>
        <Link href="/sign-in?mode=sign-up" className={createClassName}>
          Create account
        </Link>
      </li>
    </ul>
  );
  return (
    <Suspense fallback={plain}>
      <AuthMenuLinksContent>{links}</AuthMenuLinksContent>
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
