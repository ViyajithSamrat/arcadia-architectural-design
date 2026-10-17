import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getSupabasePublicConfig } from "@/lib/supabase/config";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

type Props = { searchParams: Promise<{ error?: string }> };

async function SignInContent({ searchParams }: Props) {
  await connection();
  const { error } = await searchParams;
  const configured = getSupabasePublicConfig() !== null;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {error ? (
        <p role="alert" className="rounded border p-3">
          That sign-in link did not work or has expired. Request a new one below.
        </p>
      ) : null}
      {configured ? (
        <SignInForm />
      ) : (
        <p className="rounded border p-3">
          Sign-in is not available yet because the authentication service has not been configured.
        </p>
      )}
    </div>
  );
}

export default function SignInPage({ searchParams }: Props) {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <SignInContent searchParams={searchParams} />
    </Suspense>
  );
}
