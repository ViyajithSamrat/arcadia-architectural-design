import Link from "next/link";

/**
 * Phase 1 home page. The customer journeys are built in Phase 3, so they are
 * listed here as "not available yet" and are deliberately not links.
 */
const PLANNED = [
  {
    name: "New build on an empty plot",
    detail: "Describe a plot and rooms; receive a labelled illustrative layout and concept images.",
  },
  {
    name: "Interior refresh",
    detail: "Share room photos and style preferences; receive interior concept images.",
  },
  {
    name: "Landscape design",
    detail: "Describe an outdoor area and conditions; receive landscape concept images.",
  },
] as const;

export default function Home() {
  return (
    <div className="space-y-10">
      <section aria-labelledby="home-title" className="space-y-4">
        <h1 id="home-title" className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Architectural AI Design
        </h1>
        <p className="max-w-2xl text-lg text-muted">
          A concept-design prototype. You describe a space in text or voice, review a clear
          English brief and a quote, and receive AI-generated design ideas after payment is
          confirmed by an administrator.
        </p>
      </section>

      <section
        aria-labelledby="build-note-title"
        className="rounded-lg bg-warning-bg px-5 py-4 text-warning-fg"
      >
        <h2 id="build-note-title" className="font-semibold">
          Early build: foundation only
        </h2>
        <p className="mt-1">
          The design journeys, quotes, payments, and AI features are not available yet. This
          page only confirms that the application foundation is running.
        </p>
      </section>

      <section aria-labelledby="planned-title" className="space-y-4">
        <h2 id="planned-title" className="text-xl font-semibold">
          Planned journeys
        </h2>
        <ul className="grid gap-4 sm:grid-cols-3">
          {PLANNED.map((item) => (
            <li key={item.name} className="rounded-lg border border-border bg-surface p-4">
              <h3 className="font-semibold">{item.name}</h3>
              <p className="mt-1 text-sm text-muted">{item.detail}</p>
              <p className="mt-3 text-sm font-medium">Not available yet</p>
            </li>
          ))}
        </ul>
      </section>

      <p>
        <Link href="/status" className="font-medium underline underline-offset-4">
          Check system status
        </Link>
      </p>
    </div>
  );
}
