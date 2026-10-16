# Project Overview â€” Architectural AI Design Web Prototype

## Purpose

Build a demo-ready web application that helps customers turn spoken or typed requests into a reviewed English design brief, receive an itemized quote, submit evidence of an offline UPI/bank transfer, and access AI-generated conceptual outputs only after server-side payment verification and authorized administrator release.

## Three supported customer journeys

1. **New Build on Empty Plot** â€” collect plot/building requirements, render an illustrative labelled 2D SVG room layout from structured data, and generate static exterior/interior concept views.
2. **Interior Refresh** â€” collect existing-room details, preferences, budget, must-preserve features, and reference photos/floor plans; generate interior concept images and a text summary.
3. **Landscape Design** â€” collect outdoor-area, climate, sunlight, water, maintenance, and feature requirements; generate landscape concept images and a text summary.

## Proposed technical stack in the source specification

- Next.js App Router + TypeScript
- Tailwind CSS, shadcn/ui, Lucide icons
- Supabase Postgres, Auth, and private Storage
- Gnani Prisma for speech-to-text and Gnani Timbre for text-to-speech, through server-only adapters
- Configurable text/image model access through OpenRouter, subject to provider capability validation
- Deterministic SVG rendering for labelled 2D floor-plan illustrations

Exact endpoints, provider capabilities, credentials, and pricing must be validated against the actual accounts. Do not assume access merely because a provider is named.

## Non-negotiable security invariants

1. Generation is allowed only after **server-verified payment**.
2. Customer asset access is allowed only after **authorized administrator release**.
3. Hiding a button in the UI is not authorization; enforce access in server handlers, database policies, and storage policies.
4. Keep provider secrets server-side and protect payment evidence, source photos, audio, and unreleased outputs.
5. Validate AI outputs against strict schemas before rendering or persisting them.

## Scope and limitations

This is a four-working-day proof of concept, not a production architectural-design service. Do not claim outputs are construction-ready, certified, structurally validated, code-compliant, or CAD/BIM deliverables. CAD/BIM export, automated payment gateways, bank reconciliation, high-volume production scale, and extensive production hardening are out of PoC scope.

## Delivery strategy

Deliver a vertical slice in phases. Verify provider credentials and smoke tests on Day 1. Use clearly labelled development mocks only when live provider integration is unavailable. Gate each phase on its acceptance criteria and actual test results.

## Detailed documents

- Product: [`01_PRD.md`](01_PRD.md)
- Technical design: [`02_TRD.md`](02_TRD.md)
- Flows/state machine: [`03_APP_FLOW.md`](03_APP_FLOW.md)
- UI/UX: [`04_UI_UX.md`](04_UI_UX.md)
- Data model: [`05_BACKEND_SCHEMA.md`](05_BACKEND_SCHEMA.md)
- Execution plan: [`06_IMPLEMENTATION_PLAN.md`](06_IMPLEMENTATION_PLAN.md)
- Runtime prompts: [`07_RUNTIME_PROMPT_TEMPLATES.md`](07_RUNTIME_PROMPT_TEMPLATES.md)
- Risks: [`08_RISK_REGISTER.md`](08_RISK_REGISTER.md)
- Demo: [`09_DEMO_SCRIPT.md`](09_DEMO_SCRIPT.md)
- Hardening: [`10_HANDOFF_AND_HARDENING.md`](10_HANDOFF_AND_HARDENING.md)
- Open decisions: [`11_DECISIONS_AND_OPEN_QUESTIONS.md`](11_DECISIONS_AND_OPEN_QUESTIONS.md)
- Claude Code prompt: [`12_CLAUDE_CODE_MASTER_PROMPT.md`](12_CLAUDE_CODE_MASTER_PROMPT.md)
- Architecture decision: [`13_ARCHITECTURE_DECISION.md`](13_ARCHITECTURE_DECISION.md)
