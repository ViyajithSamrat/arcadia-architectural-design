"use client"; // Error boundaries must be Client Components

/**
 * Route-level error page. It never prints the error message or stack, because
 * those can contain internal details (SEC-12). Next.js passes `retry` (not the
 * older `reset`) in this version.
 */
export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted">
        We could not show this page. You can try again. If the problem continues, please come
        back later.
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="rounded-lg bg-accent px-5 py-2 font-medium text-accent-contrast"
      >
        Try again
      </button>
    </div>
  );
}
