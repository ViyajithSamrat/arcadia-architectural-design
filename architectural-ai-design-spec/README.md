# Architectural AI Design — Claude Code Specification

This folder separates the source project specification into focused Markdown documents so Claude Code can load the right context without repeatedly parsing one large file.

## Source and interpretation rules

- The original project PDF is the source of truth.
- The consolidated specification preserves source requirements and marks implementation proposals or unresolved decisions where the PDF does not specify an answer.
- Do not silently turn proposed details into confirmed product requirements.
- This is a four-working-day proof of concept (PoC), not a production architectural-design service.

## Read order

1. [`00_PROJECT_OVERVIEW.md`](00_PROJECT_OVERVIEW.md) — context, scope, invariants, and links.
2. [`01_PRD.md`](01_PRD.md) — product requirements and acceptance criteria.
3. [`02_TRD.md`](02_TRD.md) — technical architecture, stack, APIs, security, and tests.
4. [`03_APP_FLOW.md`](03_APP_FLOW.md) — customer journeys, state machine, voice, generation, and payment flows.
5. [`04_UI_UX.md`](04_UI_UX.md) — page inventory, forms, components, states, and UX checks.
6. [`05_BACKEND_SCHEMA.md`](05_BACKEND_SCHEMA.md) — data entities, constraints, pricing, RLS, and storage.
7. [`06_IMPLEMENTATION_PLAN.md`](06_IMPLEMENTATION_PLAN.md) — phased execution plan and acceptance gates.
8. [`07_RUNTIME_PROMPT_TEMPLATES.md`](07_RUNTIME_PROMPT_TEMPLATES.md) — prompts used by the application at runtime.
9. [`08_RISK_REGISTER.md`](08_RISK_REGISTER.md) — project risks and mitigations.
10. [`09_DEMO_SCRIPT.md`](09_DEMO_SCRIPT.md) — five-minute demonstration.
11. [`10_HANDOFF_AND_HARDENING.md`](10_HANDOFF_AND_HARDENING.md) — post-PoC improvements.
12. [`11_DECISIONS_AND_OPEN_QUESTIONS.md`](11_DECISIONS_AND_OPEN_QUESTIONS.md) — decisions that need validation.
14. [`13_ARCHITECTURE_DECISION.md`](13_ARCHITECTURE_DECISION.md) — final architecture decision.

## Instructions for Claude Code

Before coding, read `CLAUDE.md`, `00_PROJECT_OVERVIEW.md`, `01_PRD.md`, `02_TRD.md`, `03_APP_FLOW.md`, `05_BACKEND_SCHEMA.md`, and `06_IMPLEMENTATION_PLAN.md`. Read UI/UX and prompt templates before implementing their corresponding features.

Execute one phase at a time. Inspect the repository first, preserve existing working code, run tests, and report evidence for each acceptance gate. Never claim a test, integration, migration, or deployment succeeded unless it actually did.

## Document map

| File | Primary purpose |
|---|---|
| `CLAUDE.md` | Persistent project instructions for Claude Code |
| `00_PROJECT_OVERVIEW.md` | Executive summary, scope, security invariants |
| `01_PRD.md` | Product and user requirements |
| `02_TRD.md` | Technical design and implementation contracts |
| `03_APP_FLOW.md` | Application journeys and state transitions |
| `04_UI_UX.md` | UX and interface specification |
| `05_BACKEND_SCHEMA.md` | Database and authorization design |
| `06_IMPLEMENTATION_PLAN.md` | Phases, schedule, acceptance criteria |
| `07_RUNTIME_PROMPT_TEMPLATES.md` | Model prompts and output constraints |
| `08_RISK_REGISTER.md` | Risks and mitigations |
| `09_DEMO_SCRIPT.md` | Demo sequence |
| `10_HANDOFF_AND_HARDENING.md` | Post-PoC hardening |
| `11_DECISIONS_AND_OPEN_QUESTIONS.md` | Open decisions |
| `13_ARCHITECTURE_DECISION.md` | Architecture summary |
