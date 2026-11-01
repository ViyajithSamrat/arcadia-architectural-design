import Link from "next/link";
import { SignInLink } from "@/components/layout/auth-controls";
import type { PageAccess } from "@/lib/journeys/access";
import { Notice } from "./notice";
import { buttonPrimary, buttonSecondary } from "./styles";

/** Shown instead of a page when nobody is signed in, or sign-in is not configured. */
export function AccessGate({ access }: { access: Exclude<PageAccess, { state: "ok" }> }) {
  if (access.state === "not_configured") {
    return (
      <>
        <h1 className="sr-only">Sign-in is not available yet</h1>
        <Notice tone="warning" title="Sign-in is not available yet">
          <p>
            The account service has not been configured, so projects cannot be saved. Nothing you type is sent anywhere.
            See the system status page for details.
          </p>
          <p>
            <Link href="/status" className="underline underline-offset-4">
              System status
            </Link>
          </p>
        </Notice>
      </>
    );
  }
  return (
    <div className="space-y-4">
      <h1 className="sr-only">Sign in to continue</h1>
      <Notice tone="info" title="Sign in to continue">
        <p>
          Your project is saved privately to your account, so you need to sign in first. Sign in with your email and
          password, or create a free account; you come back to this page afterwards.
        </p>
      </Notice>
      <div className="flex flex-wrap gap-3">
        <SignInLink className={buttonPrimary} />
        <SignInLink className={buttonSecondary} signUp>
          Create account
        </SignInLink>
      </div>
    </div>
  );
}
