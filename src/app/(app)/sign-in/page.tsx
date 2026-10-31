import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { PHOTOS } from "@/components/landing/photos";
import { Loading } from "@/components/journey/loading";
import { Notice } from "@/components/journey/notice";
import { buttonPrimary, buttonSecondary } from "@/components/journey/styles";
import { SignOutButton } from "@/components/layout/auth-controls";
import { getAuthProviders } from "@/lib/auth/credentials";
import { safeNextPath } from "@/lib/auth/next-path";
import { getAccountSummary } from "@/lib/auth/session";
import { signInErrorMessage } from "@/lib/auth/sign-in-errors";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { SignInForm, type AuthMode } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

type Props = { searchParams: Promise<{ error?: string; next?: string; mode?: string }> };

const MODES: readonly AuthMode[] = ["sign-in", "sign-up", "forgot"];

async function SignInContent({ searchParams }: Props) {
  await connection();
  const { error, next, mode } = await searchParams;
  const configured = getSupabasePublicConfig() !== null;
  const returnTo = safeNextPath(next);
  const account = configured ? await getAccountSummary() : null;

  if (account) {
    return (
      <Frame>
        <div className="space-y-6">
          <p className="eyebrow">Your account</p>
          <h1 className="font-display">You are signed in</h1>
          <p>
            Signed in as <span className="font-medium break-all">{account.email ?? "this account"}</span>.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {returnTo ? (
              <Link href={returnTo} className={buttonPrimary}>
                Continue to the page you were on
              </Link>
            ) : null}
            <Link href="/projects" className={returnTo ? buttonSecondary : buttonPrimary}>
              My projects
            </Link>
            <SignOutButton className={buttonSecondary} />
          </div>
        </div>
      </Frame>
    );
  }

  const providers = configured ? await getAuthProviders() : null;
  const initialMode = MODES.find((m) => m === mode) ?? "sign-in";

  return (
    <Frame>
      <div className="space-y-8">
        <header className="space-y-4">
          <p className="eyebrow">Welcome to GNANI</p>
          <h1 className="font-display">Your projects, in one place</h1>
          <p className="text-muted">
            Sign in or create a free account to save your project. You return to {returnTo ? "the page you were on" : "My projects"}{" "}
            afterwards. Browsing the site does not need an account.
          </p>
        </header>
        {error ? (
          <Notice tone="danger" role="alert">
            <p>{signInErrorMessage(error)}</p>
          </Notice>
        ) : null}
        {configured ? (
          <SignInForm next={returnTo} googleEnabled={providers?.google === true} initialMode={initialMode} />
        ) : (
          <Notice tone="warning" title="Sign-in is not available yet">
            <p>The authentication service has not been configured.</p>
          </Notice>
        )}
      </div>
    </Frame>
  );
}

/** Split screen: an architectural photograph beside the form; the photograph steps aside on small screens. */
function Frame({ children }: { children: ReactNode }) {
  const photo = PHOTOS.livingRoom;
  return (
    <div className="grid overflow-hidden rounded-[4px] border border-border bg-paper shadow-soft lg:min-h-[44rem] lg:grid-cols-2">
      <figure className="gn-grain relative isolate hidden min-h-[16rem] overflow-hidden bg-forest text-white lg:block">
        <Image src={photo.src} alt={photo.alt} fill sizes="(max-width: 1024px) 0px, 50vw" className="-z-20 object-cover" />
        <span aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-t from-[rgb(15_28_24/0.9)] via-[rgb(15_28_24/0.35)] to-[rgb(15_28_24/0.15)]" />
        <figcaption className="flex h-full flex-col justify-between p-10">
          <span className="font-display text-2xl font-semibold tracking-[0.18em]">GNANI</span>
          <span className="space-y-4">
            <span className="block font-display text-5xl font-medium leading-[1.02]">
              Every project begins <em className="italic text-[#d9d2c3]">in your own words.</em>
            </span>
            <span className="block text-xs text-white/65">
              Reference photograph: {photo.title}, {photo.creator} ({photo.license})
            </span>
          </span>
        </figcaption>
      </figure>
      <div className="flex items-center px-6 py-12 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}

export default function SignInPage({ searchParams }: Props) {
  return (
    <Suspense fallback={<Loading />}>
      <SignInContent searchParams={searchParams} />
    </Suspense>
  );
}
