# Architectural AI Design — Web Prototype

A concept-design prototype. A customer describes a building, an interior, or a garden; the app turns it into an English brief and a quote; an administrator verifies an offline payment; and only then are AI concept images generated and released.

Outputs are conceptual design ideas, not construction drawings, CAD/BIM models, or code-compliant plans.

**Current state: Phase 1 (foundation) only.** The customer journeys, database, payments, and AI features are not built yet. Nothing in the running app pretends otherwise.

## What exists now

- Next.js App Router, TypeScript, Tailwind CSS.
- Shared layout, accessible header/footer/skip link, and a home page.
- `/status` page and `GET /api/health`: show which optional services have their settings present. They show names and states only, never values, and "configured" never means "verified".
- Safe not-found, error, and global-error pages that do not reveal internal details.
- Environment validation (`src/lib/env/schema.ts`): every variable is optional, a provided value must be well-formed, and problems are reported by variable name only.
- Unit tests for the environment check, integration statuses, and the health route.

## Requirements

- Node.js 22.12+ (developed on Node 24) and npm.
- No accounts or API keys are needed for Phase 1.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
```

Open `/status` or `/api/health` to see the configuration state.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Configuration

Copy `.env.example` to `.env.local` and fill values only when a phase needs them. All values are blank by default, and `.env.local` is git-ignored. Descriptions of every variable are in `architectural-ai-design-spec/ENVIRONMENT_VARIABLES.md`.

Never put a secret in a `NEXT_PUBLIC_*` variable: those are sent to the browser.

## Project layout

```
CLAUDE.md                Project instructions for Claude Code (copy of the spec folder's guide)
AGENTS.md                Written by Next.js: agents read its bundled docs first
.env.example             Blank environment template
src/app/                 Pages, error pages, and API routes
src/components/          Shared layout and UI components
src/lib/env/             Environment schema and validation
src/lib/integrations/    Integration status (presence only, never values)
tests/unit/              Unit tests
architectural-ai-design-spec/            Product and technical specification
architectural-ai-skill-integrated-prompts/   Phase prompts and build orchestration
```

## Notes for developers

- This project uses Next.js 16 with Cache Components enabled. Code that reads environment values at request time calls `await connection()` first (see `src/app/api/health/route.ts`). Do not use `dynamic = "force-dynamic"`.
- Error pages receive `retry`, not the older `reset`.
- System fonts only. No external font or asset requests are made.
- `AGENTS.md` is written by Next.js; it tells coding agents to read the bundled docs in `node_modules/next/dist/docs/` before writing Next.js code.

## Roadmap

1. Foundation (this phase)
2. Database, sign-in, and private storage
3. Customer journeys and quote
4. Payment evidence and admin review
5. AI text and voice
6. Image generation and controlled release
7. End-to-end QA and demo handoff

Each phase is approved by the project owner before the next one starts.
