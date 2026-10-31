import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Notice } from "@/components/journey/notice";
import { buttonPrimary, card } from "@/components/journey/styles";
import { getAccountSummary } from "@/lib/auth/session";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { NewPasswordForm } from "./new-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

/** Reached from a password reset link through /auth/callback, which signs the browser in first. */
async function ResetContent() {
  await connection();
  const account = getSupabasePublicConfig() ? await getAccountSummary() : null;
  if (!account) {
    return (
      <div className="space-y-4">
        <Notice tone="warning" title="This reset link cannot be used">
          <p>
            It has expired, was already used, or was opened in a different browser or window from the one that asked for it.
            Request a new link and open it in the same window.
          </p>
        </Notice>
        <Link href="/sign-in?mode=forgot" className={buttonPrimary}>
          Request a new reset link
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-muted">
        Signed in as <span className="font-medium break-all text-foreground">{account.email ?? "your account"}</span>. Choose a new
        password; you will use it the next time you sign in.
      </p>
      <div className={card}>
        <NewPasswordForm />
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="mx-auto max-w-md space-y-5">
      <h1 className="font-display text-3xl font-medium tracking-tight">Choose a new password</h1>
      <Suspense fallback={<p>Loading...</p>}>
        <ResetContent />
      </Suspense>
    </div>
  );
}
