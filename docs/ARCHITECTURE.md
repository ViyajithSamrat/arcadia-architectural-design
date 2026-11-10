# Architecture

This document explains how ARCADIA is put together and why the security-sensitive parts are built the way they are. For setup see the [README](../README.md); for hosting see [DEPLOYMENT.md](DEPLOYMENT.md).

## Overview

```
Browser ──► Next.js (Vercel) ──► Supabase  Postgres (RLS + workflow triggers), Auth, private Storage
                 │
                 ├──► OpenRouter   brief wording, concept images
                 └──► Gnani        speech-to-text, text-to-speech
```

- **Pages and actions** live in `src/app` (customer pages under `/projects`, administrator pages under `/admin`, JSON/file routes under `/api`). Server Actions and route handlers are public endpoints: each authenticates and authorizes itself.
- **Business logic** lives in `src/lib`, away from the UI: `journeys` (steps, validation, brief, quote), `payments`, `generation`, `providers`, `voice`, `pricing`, `supabase`, `auth`, `storage`.
- **The browser never talks to Supabase.** All reads and writes go through the server with the signed-in user's session. The Content-Security-Policy `connect-src` is `'self'`, and a test fails if a browser Supabase client is added.

## Three clients, three trust levels

| Client | Credential | Used for |
|---|---|---|
| User session (`createSupabaseServerClient`) | publishable key + the user's cookies | Ordinary reads and writes. Row level security applies. Administrator payment decisions and manual release also use the administrator's *own* session so the database records who acted. |
| Service (`createSupabaseServiceClient`, `server-only`) | secret key | Trusted server work after the caller was authenticated and authorized: saving the description, the usage ledger, generation jobs and files, automatic release. It bypasses RLS, so it is never used to serve ordinary customer reads. |
| Browser | none | Does not exist. |

## The workflow and who may move it

`public.project_status_transitions` lists the allowed transitions; triggers refuse every other. Customers cannot change a project's status at all.

| Transition | Who/what can do it |
|---|---|
| `DRAFT … BRIEF_APPROVED → QUOTED → AWAITING_PAYMENT` | The owner, through server code with an ownership check |
| `→ PAYMENT_PROOF_SUBMITTED` | A payment insert by the owner (a database cascade) |
| `→ PAYMENT_VERIFIED` / `PAYMENT_REJECTED` | Only `admin_verify_payment` / `admin_reject_payment`, which check `is_admin()` and require the confirmed amount to equal the accepted quote's total |
| `→ GENERATING` | Trusted server code, only with a verified payment for the accepted quote |
| `→ READY_FOR_REVIEW` | Trusted server code, only with a succeeded job and generated assets |
| `→ RELEASED` | `admin_release_project` (administrator session) or `system_release_project` (service role; see below) |

The same guards hold even if application code has a bug: the database is the last line of defence.

## Payment to concepts, automatically

1. The customer submits payment evidence. The project becomes `PAYMENT_PROOF_SUBMITTED`. Evidence is a claim, not proof.
2. An administrator reviews it and verifies the full amount (or rejects with a reason). In one transaction the payment becomes `VERIFIED` and the project `PAYMENT_VERIFIED`, with audit events.
3. **That persisted state is the outbox.** A verified payment with no job yet is durable, queryable evidence that generation is owed. The verify action then schedules the run with `after()`, so the administrator's request does not wait for the image provider.
4. `runGeneration` claims the project with a conditional update (`PAYMENT_VERIFIED → GENERATING`), creates a job, calls the provider, validates the output, stores the images privately and records them as unreleased assets through `insert_generated_asset`, then marks the job and project.
5. When the job succeeded and the output is real (not placeholder), `system_release_project` releases the project and its files to the owner. Placeholder output stays at `READY_FOR_REVIEW` for an administrator.
6. The customer's open project page watches `/api/projects/[id]/status` and refreshes itself when the status changes.

**Exactly once.** Three independent layers, none trusting the caller:

1. The idempotency key is derived from the verified payment (`auto-<payment id>`); a repeat is a replay and never a second provider call.
2. The conditional claim means only one of any number of concurrent callers proceeds.
3. The database allows one active job per project, and a job only while the project is `GENERATING` with a verified payment.

**Recovery.** If the scheduled run never happens (the process ended first), the project stays `PAYMENT_VERIFIED`, and the status endpoint re-triggers the same idempotent run after a short delay. A failed job moves the project to `GENERATION_FAILED`, which an administrator sees and can retry with a new key; a failed attempt's files are removed, and release refuses files from any job that did not succeed.

**Automatic release.** `system_release_project` is a separate, service-role-only function. It re-checks everything inside the database under a row lock: the project is `READY_FOR_REVIEW`, the payment is verified, no job is running, every generated file belongs to a succeeded job, and no succeeded job is placeholder output. It cannot be called by customers, anonymous users or administrators' own sessions. `GENERATION_AUTO_RELEASE=false` switches the application off from calling it, which restores the previous administrator-review step. `admin_release_project` is unchanged.

## Storage and privacy

One private bucket, `project-files`, with paths `<project id>/<kind>/<file>`:

- `references/` — customer photos (owner read/write while the project is editable).
- `payment-proofs/` — receipts (owner write while awaiting payment; owner and administrators read).
- `generated/` — concept images. Customers can read a generated file only when its asset row is released; administrators can read all.

Files are served through short-lived signed URLs created with the *reader's own session*, so Storage policies decide access. Uploads are limited to 4 MiB through the app (Vercel's request-body limit is 4.5 MB; the bucket's own 5 MiB is the outer bound), to JPEG, PNG or WebP, and the type is checked from the file's own bytes.

## The 2D drawing

For new-build projects the on-screen layout sketch and the downloadable DXF are written from the **same structured layout** (`layoutFloorPlan`), never from the AI images. The layout is deterministic and is drawn on demand from the project's saved answers, which freeze when the quote is accepted. Nothing is stored, so there is no file or link to leak: `/api/projects/[id]/plan` authorizes every download (owner, `RELEASED`).

The data limits what is honest to draw. The customer supplies only plot width, plot length and a unit, so the DXF holds the plot outline at true size with its two dimensions, plus one schematic outline per requested room, labelled, on separate layers per floor. It contains no walls, doors, windows, openings or room dimensions, and says so inside the file. It is not a construction drawing.

## AI providers

Every provider sits behind a small server-side interface (`src/lib/providers`). Rules that apply to all of them:

- **Model output is untrusted data.** It is parsed and strictly validated; the server composes the stored brief; image bytes are type-, size- and dimension-checked before storage. No model response grants permission, verifies a payment or releases anything.
- **Spend is bounded.** A provider call first reserves usage in a database ledger with per-customer and global caps; a refusal means no call.
- **Failures are explicit.** Timeouts, rate limits and malformed responses surface as a failed job or an "unavailable" state, never as a fabricated success. Provider detail is not logged or shown.
- **Configuration is fail-closed.** An incomplete live configuration reports "unavailable"; it never silently becomes a placeholder.

## Auditability

Critical transitions write append-only `audit_events` (payment submitted/verified/rejected, generation requested/started/succeeded/failed, release, automatic release, configuration changes). Update and delete on that table are blocked by triggers.

## Testing strategy

| Suite | What it covers | How it runs |
|---|---|---|
| `tests/unit` | Validation, services, routes, components, provider adapters | `npm test`, network blocked |
| `tests/db` | The real migrations in an in-process PostgreSQL: RLS, grants, workflow guards, release invariants | `npm test` |
| `tests/live` | The same against a real local Supabase stack | opt-in, setup is destructive to *local* data only |

A mocked integration test proves the application's side of a contract, not that the live provider works.
