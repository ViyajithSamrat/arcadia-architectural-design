import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted">We could not find the page you asked for.</p>
      <p>
        <Link href="/" className="font-medium underline underline-offset-4">
          Return home
        </Link>
      </p>
    </div>
  );
}
