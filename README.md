# GNANI — Architectural AI Design

GNANI turns a plain description of a building, a room or a garden into an English design brief, an itemized quote and AI-generated concept images. A customer describes what they want in text (or by voice where enabled), reviews the brief and quote, and sends evidence of an offline payment. A person verifies the payment; generation then starts automatically and the finished concepts appear in the customer's project.

The output is **conceptual**. Generated images and the layout sketch are illustrations for exploring ideas. They are not construction drawings, engineering plans, CAD/BIM deliverables or code-compliant designs, and nothing in the product says otherwise.

## Features

- **Three journeys** — a new build on an empty plot, an interior refresh, and landscaping. Each is a validated multi-step form.
- **Brief** — the answers become a structured English brief. With a live provider the wording is drafted by an OpenRouter text model; the server composes and validates the stored brief, so model output is never trusted as data.
- **Quote** — priced on the server from administrator-managed pricing rules, itemized, and frozen when the customer accepts it.
- **Payment** — manual/offline. The customer submits a reference and an optional receipt image; an administrator verifies the full quoted amount or rejects with a reason. There is **no payment gateway**; a clearly labelled simulated checkout exists for demonstrations.
- **Automatic generation** — verifying a payment starts image generation without a second click. The customer's project page updates by itself and shows the images when they are ready.
- **2D layout drawing** — for new builds, an editable DXF (and SVG) generated from the same structured layout as the on-screen sketch. See [Limitations](#limitations).
- **Voice (optional)** — Gnani speech-to-text for dictating a description and text-to-speech for reading the brief back. Off unless configured.
- **Administration** — payment review queue, generation monitor and retry, pricing management.
- **Security by design** — row level security, private storage, server-side authorization on every action, audit events. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How a project moves

```
DRAFT → BRIEF_REVIEW → BRIEF_APPROVED → QUOTED → AWAITING_PAYMENT → PAYMENT_PROOF_SUBMITTED
   → (administrator verifies) PAYMENT_VERIFIED → GENERATING → READY_FOR_REVIEW → RELEASED
                         ↘ PAYMENT_REJECTED (customer resubmits)      ↘ GENERATION_FAILED (retryable)
```

Verification starts generation automatically. When the job finishes with real (non-placeholder) output, the project is released to its owner automatically; placeholder output and failures wait for an administrator. Every transition is enforced by the database, not only by the application.

## Technology

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router, Cache Components), React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Data, auth, files | Supabase: PostgreSQL with row level security, Auth, private Storage |
| AI | OpenRouter (text and image models) |
| Voice | Gnani speech-to-text and text-to-speech |
| Hosting | Vercel |
| Tests | Vitest, with an in-process PostgreSQL (PGlite) for database tests |

## Getting started

Requirements: Node.js 20.9 or newer (developed on Node 24), npm, and Docker only if you want a local Supabase stack.

```bash
npm ci
cp .env.example .env.local     # every value is blank by default; fill in only what you need
npm run dev                    # http://localhost:3000
```

With no environment variables set the app still runs: pages render, and anything that needs Supabase, a provider or voice reports itself as unavailable instead of pretending to work. Nothing is mocked silently; placeholder output is always labelled.

### Checks

```bash
npm test                       # unit and database tests (no network, no Docker)
npm run typecheck
npm run lint
npm run build                  # production build
npm start                      # serve the production build
```

`npm run smoke:providers` runs opt-in live provider checks. It is skipped unless `LIVE_PROVIDER_SMOKE=1` and real credentials are present, and it can spend credits.

### Local Supabase (optional)

```bash
npx supabase start -x studio,realtime,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta
npx supabase status -o env     # copy the URL and keys into .env.local
```

Starting the stack applies every migration in `supabase/migrations/`. Never run `supabase db reset`, or any database command against a hosted project, without meaning to. See [docs/SUPABASE.md](docs/SUPABASE.md).

## Configuration

Copy `.env.example` to `.env.local`. `.env*` files are git-ignored (only `.env.example` is tracked). The full variable reference is in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md). The essentials:

| Purpose | Variables |
|---|---|
| Supabase (browser-safe) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (legacy fallback: `NEXT_PUBLIC_SUPABASE_ANON_KEY`) |
| Supabase (server only) | `SUPABASE_SECRET_KEY` (legacy fallback: `SUPABASE_SERVICE_ROLE_KEY`) |
| App origin | `NEXT_PUBLIC_APP_URL` — the exact public URL; sign-in and upload origin checks use it |
| OpenRouter | `PROVIDER_MODE=live`, `OPENROUTER_API_KEY`, `OPENROUTER_TEXT_MODEL`, `OPENROUTER_IMAGE_MODEL` |
| Gnani voice | `GNANI_VOICE_ENABLED=true` plus the `GNANI_*` settings and `VOICE_TRANSCRIPT_SECRET` |
| Manual payment display | `PAYMENT_MODE`, `PAYMENT_UPI_ID` / `PAYMENT_INSTRUCTIONS`, `PAYMENT_CURRENCY` |

**Never put a secret in a `NEXT_PUBLIC_*` variable** — those are sent to every browser. The app treats a secret Supabase key in a public variable as a configuration error and reports Supabase as not configured.

## Integrations

- **OpenRouter** drafts the brief wording and generates concept images. `PROVIDER_MODE` unset or `mock` uses clearly labelled placeholder generators; `live` needs the key and models, and an incomplete live configuration reports "unavailable" rather than falling back to placeholders. Every provider call reserves usage in a database budget guard first.
- **Gnani** provides speech-to-text and text-to-speech. Voice is off unless `GNANI_VOICE_ENABLED=true` and every Gnani setting is present. Spoken read-back needs the customer's consent and stores no audio.

Provider behaviour, limits and verification notes: [docs/PROVIDERS.md](docs/PROVIDERS.md). Provider output is always treated as untrusted and validated before use.

## Deploying to Vercel

The app deploys as a standard Next.js project. Set the environment variables listed in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the Production environment, apply the database migrations to your Supabase project, configure Supabase Auth (site URL, redirect URL, password policy), create the first administrator, and redeploy after any environment change. The deployment guide has the full checklist, including the platform limits the code is designed around (4.5 MB request bodies, function duration).

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, workflow, security model, automatic generation, 2D drawing |
| [docs/SUPABASE.md](docs/SUPABASE.md) | Migrations, Auth checklist, administrators, RLS and Storage |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | Every environment variable |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel setup, environment checklist, release checklist |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | OpenRouter and Gnani integration notes |
| [docs/PRIVACY_RETENTION_CHECKLIST.md](docs/PRIVACY_RETENTION_CHECKLIST.md) | Draft privacy and retention decisions still to be made |
| [supabase/README.md](supabase/README.md) | Database folder notes |

## Limitations

- **Payments are manual.** Nothing here moves money. Customers pay outside the app; a person confirms receipt. The simulated checkout is for demonstrations and is labelled as such.
- **Concepts are not buildable designs.** Images are AI illustrations, and any text or dimensions inside them are part of the illustration.
- **The 2D drawing is a schematic layout.** The customer gives only the plot width, plot length and unit, so the DXF contains the plot outline at true size (dimensioned) and one outline per requested room or space. Room outlines carry no sizes, and no walls, doors, windows or openings are drawn, because no such data exists to draw them from. It is available for new-build projects only.
- **Automatic release applies to real output only.** Placeholder images are never released automatically.
- **Rate limits for voice routes are per server instance**, so they are weaker on serverless hosting; the limits that control cost live in the database.
- **Hosted environment:** a hosted Supabase project and Vercel deployment require their own setup and verification; passing local tests does not prove them.

## Contributing

Keep changes small and tested. Database changes are forward-only migrations in `supabase/migrations/` with a matching rollback in `supabase/rollbacks/`. Never weaken a security rule to make a test pass: explain the change first. Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build` before proposing a change. This project uses Next.js 16 with Cache Components: request-time reads belong behind `<Suspense>` and `connection()`, and `AGENTS.md` points coding agents to the Next.js docs bundled in `node_modules/next/dist/docs/`.
