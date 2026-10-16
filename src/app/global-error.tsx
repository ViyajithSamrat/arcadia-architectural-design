"use client"; // Error boundaries must be Client Components

/**
 * Last-resort error page for failures in the root layout. It replaces the whole
 * document, so it defines its own html/body and uses inline styles only.
 * It never prints the error message or stack.
 */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          background: "#faf7f2",
          color: "#232323",
          margin: 0,
          padding: "3rem 1rem",
        }}
      >
        <div role="alert" style={{ maxWidth: 640, margin: "0 auto" }}>
          <h1>Something went wrong</h1>
          <p>The application could not load. You can try again.</p>
          <button
            type="button"
            onClick={() => retry()}
            style={{
              background: "#1f4d3a",
              color: "#ffffff",
              border: 0,
              borderRadius: 8,
              padding: "0.6rem 1.2rem",
              fontSize: "1rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
