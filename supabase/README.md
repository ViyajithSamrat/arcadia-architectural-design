# Database, sign-in and private storage (Phase 2)

Everything here is **prepared and tested locally; nothing has been applied to a real Supabase project.** See "Unverified" below.

## Layout

```
migrations/   5 forward migrations, applied in filename order
rollbacks/    one *.down.sql per migration (destructive: drops data; run newest first)
```

| Migration | Contents |
|---|---|
| `..000100_helpers_and_admin` | private schema `app_private`, `updated_at` trigger, `admin_users`, `is_admin()` |
| `..000200_core_tables` | all tables, CHECK constraints, 24 seeded status transitions, spec 5.10 indexes |
| `..000300_workflow_guards` | guard triggers, audit trail, `admin_verify_payment`, `admin_reject_payment`, `admin_release_project` |
| `..000400_rls_and_grants` | row level security, column-level grants, policies |
| `..000500_storage` | private bucket `project-files` and `storage.objects` policies |

## Schema map

| Table | Purpose | Owner / access | Key & status |
|---|---|---|---|
| `admin_users` | Who is an administrator (the only source of admin rights) | admin read; written by trusted server/SQL only | PK `user_id` -> `auth.users` |
| `projects` | A customer's project and brief | customer owns (`customer_id`); admin reads all | 14 statuses; `approved_at` write-once |
| `project_status_transitions` | The legal status moves (24 rows from 03_APP_FLOW) | read-only to everyone | PK (`from_status`,`to_status`) |
| `quotes` | Itemized quote; frozen once accepted | customer reads own; server writes | one accepted quote per project; total = subtotal + tax - discount |
| `payments` | Customer evidence (a claim) and the admin decision | customer inserts a pending row; only admin functions decide | `PENDING_REVIEW`/`VERIFIED`/`REJECTED`; one pending per project |
| `generation_jobs` | One AI generation attempt | admin reads; server writes | `QUEUED`/`RUNNING`/`SUCCEEDED`/`FAILED`; one active job per project; idempotency key |
| `design_assets` | Uploads and generated files | customer: own uploads, and generated only once released | path must match type; `is_released` only via the release function |
| `pricing_rules`, `site_settings` | Admin-managed configuration (no seeded prices) | admin only | versioned |
| `audit_events` | Append-only record of critical transitions | admin reads; nobody can update, delete or truncate | indexed by project and payment |

Timestamps: `created_at` everywhere, `updated_at` (trigger-maintained) on mutable tables, `verified_at`/`released_at`/`approved_at` for decisions.
Sensitive fields: `payments.verified_by` and `payments.audit_note` are not readable by customers (column grants); `generation_jobs` and `audit_events` are admin-only; payment proofs live in private storage.

## How the invariants are enforced

Defense in depth, all inside the database so even a buggy or compromised server route cannot skip a rule:

- **Payment gate:** a generation job can only be created while the project is `GENERATING` **and** a `VERIFIED` payment exists (`app_private.project_has_verified_payment`). This applies to the service role too.
- **Verification:** payment status can only be decided through `admin_verify_payment` / `admin_reject_payment`, which check `is_admin()`, require a pending payment, and (for verify) a confirmed amount equal to the quote total. Decisions are final.
- **Release:** `is_released` can only be set by `admin_release_project`, and only for a `READY_FOR_REVIEW` project with generated assets and a verified payment. Released assets cannot be deleted.
- **Transitions:** a guard trigger rejects any status change not in `project_status_transitions`; customers cannot change status at all.
- **Ownership:** RLS limits customers to their own rows; admin policies use `is_admin()`.
- **Storage:** bucket `project-files` is private. Object names are `<project_id>/<references|payment-proofs|generated>/<file>`; policies parse the project from the path. Customers can read generated files only after release; nobody but trusted code can write them.
- **Audit:** payment submitted/verified/rejected, status changes, generation changes, release, and admin/pricing/settings changes are recorded in `audit_events`.

## Local setup and commands

Run the database security tests (no Supabase account, no Docker; uses an in-process PostgreSQL via PGlite):

```bash
npm test                 # unit + database tests
npx vitest run tests/db  # database tests only
```

To apply the migrations to a real project later (**needs owner approval and a project; never to production without review**):

```bash
npx supabase init                       # once, creates supabase/config.toml
npx supabase link --project-ref <ref>   # needs a Supabase access token
npx supabase db push --dry-run          # preview first
npx supabase db push                    # apply
```

A local stack (`npx supabase start`) needs Docker. To roll back, run the matching `rollbacks/*.down.sql` newest first. These drop data.

After applying, an administrator must be added by trusted SQL, for example:
`insert into public.admin_users (user_id) values ('<auth user uuid>');` (run in the SQL editor as the project owner).

Also in the Supabase dashboard: enable Email sign-in (magic link) and add `<app url>/auth/callback` to the allowed redirect URLs.

## Security test results (local, PGlite)

108 database tests cover: anonymous denied everywhere; customer A cannot read or modify customer B's projects, quotes, payments, assets or storage objects; payment proofs and unreleased generated files are not readable by other users or by the owner (generated); non-admins cannot verify, reject or release; generation is rejected before verified payment and for the wrong state; invalid and skipped transitions are rejected; audit rows cannot be changed; rollbacks remove everything and the migrations re-apply. Index usage is evidenced with before/after `EXPLAIN` for the 8 main queries (`tests/db/index-usage.test.ts`).

## Unverified (needs a real project)

- Behaviour on real Supabase Auth, Storage and PostgREST. The tests use a small stand-in for the `auth` and `storage` schemas (`tests/db/support/supabase-shim.sql`). Real `storage.objects` columns and role setup could differ.
- Magic-link email delivery and the free-plan email rate limit.
- That `project-files` can be created with no size/type limits on the free plan (limits are intentionally unset until the owner decides).
- Exposed-schema setup: only `public` should be exposed through the API; `app_private` must not be.

## Decisions recorded (owner-confirmed)

1. **One private bucket, `project-files`**, subject to verified plan limits. It is created private with no size/type limit; confirm the current Supabase plan limits (storage size, per-file size, egress) before the demo.
2. **No cancellation after payment verification** until a refund policy is defined. `PAYMENT_VERIFIED -> CANCELLED` is absent from the transition table, so the database rejects it. Adding it later is a new migration.
3. **Payment verification requires the full quoted amount.** `admin_verify_payment` rejects a confirmed amount different from the accepted quote total. Partial payments are not modelled.
4. **An authorized admin initiates generation, and only after payment verification.** Generation never starts automatically on verification. The database enforces the payment half (no job without a verified payment) for every caller; the "admin initiates" half is a Phase 4/6 server-route rule: the route must call `requireAdmin` before moving a project to `GENERATING`.
5. **Phase 4 admin routes must pass the authenticated admin identity for audit logging.** Verify, reject and release are database functions that read the caller from `auth.uid()` and require `is_admin()`, so they must be called with the administrator's own session client (`createSupabaseServerClient`), never the service-role client (the service role has no user identity and is refused). For any admin action done through the service role, the route must write the acting admin's id into the audit note; `audit_events.actor_id` is otherwise null for service-role writes.

## Review findings (Phase 2 follow-up)

- **Fixed:** the storage rollback ran `delete from storage.buckets`, which Supabase blocks (direct deletes on storage tables must use the Storage API). It no longer does; the bucket stays private and must be removed through the dashboard/API.
- **Added test:** `tests/db/non-superuser-owner.test.ts` applies the migrations as a non-superuser owner with CREATEROLE/BYPASSRLS (how Supabase's `postgres` role behaves) and repeats the workflow, gate and spoofing checks. A customer that sets the internal `app.via` flag still cannot change status.
- **Sign-up is open:** `signInWithOtp` creates an account for any email. That is intended (customer login), and admin rights come only from `admin_users`, never from sign-up.
- **Redirect origin:** sign-in links use `NEXT_PUBLIC_APP_URL` if set, else the request origin. Behind a proxy or on a deployed host, set `NEXT_PUBLIC_APP_URL` and add it, plus `/auth/callback`, to Supabase's allowed redirect URLs.
- **`select *` on payments fails for customers** by design (column grants hide `verified_by`, `audit_note`); use `PAYMENT_CUSTOMER_COLUMNS`.

## What the in-process stand-in cannot validate

The tests run on real PostgreSQL 18 (PGlite), so SQL, RLS, grants, triggers and `SECURITY DEFINER` behave as in Postgres. These parts are assumptions until tried on a real project:

- Supabase Storage API behaviour (upload/signed-URL flow, whether it needs extra privileges on `storage.buckets`) and the real `storage.objects` columns/owner. The stand-in is a minimal table.
- PostgREST: that `SET ROLE` makes `current_user` equal `anon`/`authenticated` (the guards depend on this; it is how PostgREST works, but unconfirmed here), that only `public` is exposed, and RPC exposure of the `admin_*` and `storage_object_*` functions.
- Real role grants and default privileges (the stand-in copies Supabase's documented defaults).
- Supabase's own protection triggers on storage tables, hosted-plan limits, and email delivery limits.
- Real `auth.uid()` and JWT handling, `supabase db push` ordering and CLI versions.

A first live smoke test (owner-approved, on a fresh free project) should: apply migrations, create two users and one admin, and repeat the cross-customer, payment-gate and storage checks over the real APIs.

## Remaining open decisions

- **Upload and provider limits:** unset by owner decision.
- **Payment status naming:** payment uses `PENDING_REVIEW/VERIFIED/REJECTED`; the project carries the workflow status (spec had no project-level payment column).
- **Types** are hand-written (`src/lib/db/schema.ts`, drift-tested against the migrations); switch to generated types once the Supabase CLI is set up.
- **Model configuration** (env vs `site_settings`) and **payment destination source** remain open.
- **Free-plan note:** the free plan pauses inactive projects and limits storage and email; confirm current limits before the demo. No paid service was used or needed.

## Demonstration pricing (Phase 3)

The migrations seed **no** prices. Quotes are calculated on the server from `pricing_rules`; with no rules the interface says "Pricing not configured" and refuses to create a quote.

For local development only, `supabase/demo/pricing_rules.demo.sql` loads unverified demonstration rates (INR, 18% tax) and a `site_settings` row `pricing_mode = {"mode":"demo"}`. Quotes built from them are stored with a `DEMO:` prefix on `pricing_rule_version` and are labelled "Demo rates" wherever they are shown.

- It is **not** `supabase/seed.sql`, so `supabase db reset` never applies it. Run it by hand against a local or throwaway database.
- Never run it against production. To go live, an administrator enters approved rates and removes or changes the `pricing_mode` row.
- Rule keys the application asks for are defined in `src/lib/journeys/quote.ts` (`QUOTE_LINES`, `tax_percent`). A line is requested only when the customer's answers imply a quantity above zero; a missing rule for a requested line means "Pricing not configured".
- `add_on_rate` is stored but not used yet. `included_quantity` (free units) and `minimum_charge` (floor for a requested line) are applied.
- `tests/db/demo-seed.test.ts` checks that the file loads against the real schema and produces a complete quote for each project type.

## Local live verification (real Supabase services, no account, no cost)

`supabase/config.toml` is the CLI's generated local configuration, with one change: the redirect allowlist holds `http://127.0.0.1:3000/auth/callback` and `http://localhost:3000/auth/callback`. No `seed.sql` exists, so no data is loaded automatically (demo pricing stays opt-in).

```bash
npx supabase start -x studio,realtime,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta   # needs Docker; applies the 5 migrations
npx supabase status -o env      # local URL and keys: copy NEXT_PUBLIC_SUPABASE_URL, ..._ANON_KEY and SUPABASE_SERVICE_ROLE_KEY into .env.local (git-ignored); keep the file to plain KEY=value lines (no comments, no byte-order mark: the CLI also reads .env.local and fails on both, and PowerShell's Set-Content -Encoding utf8 adds a BOM)
npx supabase stop               # when finished (add --no-backup to discard the local data)
```

Use one host name consistently within a sign-in: the cookie that completes the magic link is host-specific, so start and finish on the same one. Either `http://localhost:3000` or `http://127.0.0.1:3000` works; the sign-in link returns to the host the browser used.

**Origin policy** (`src/lib/supabase/origin.ts`, used by sign-in, sign-out and the callback): the expected origin is `NEXT_PUBLIC_APP_URL` when set, otherwise the request's own origin. For local development only, `localhost` and `127.0.0.1` count as the same machine (same scheme and port). Any other `Origin` gets 403, and `X-Forwarded-*` headers are never read. In production set `NEXT_PUBLIC_APP_URL` to the public https URL: only that origin is then accepted. Magic-link emails appear in the local inbox at `http://127.0.0.1:54324`.

`tests/live/supabase-live.live.test.ts` checks the real stack: migration order, RLS on every table, sign-in and sessions, ownership isolation, the Phase 3 service layer end to end, forbidden status moves, private storage, the payment gate and the audit trail. It is not part of `npm test` and refuses to run unless the Supabase URL is this machine:

```bash
LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts
```

It creates its own `@example.test` users each run and clears only `pricing_rules` and the `pricing_mode` setting before starting.

## Payment evidence and review (Phase 4)

**Migration 6, `20261018000100_payment_proof_limits.sql`** (rollback: `supabase/rollbacks/20261018000100_payment_proof_limits.down.sql`) sets bucket-level limits on `project-files`: images only (JPEG, PNG, WebP) and at most 5 MiB. Storage enforces them for every caller, including the service role, so they hold even if the application's own checks are bypassed. The bucket is shared, so the limit also applies to reference photos and generated files: **Phase 6 must revisit it** (for example for larger output or an SVG floor plan) in a new migration. The numbers are repeated in `src/lib/payments/evidence.ts`; keep them in step. Applied to the local stack only (`npx supabase migration up --local`); not applied to any hosted project.

Rollback by hand: `update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'project-files';`

**Payment instructions** come from the environment (`PAYMENT_MODE=manual`, `PAYMENT_UPI_ID` and/or `PAYMENT_INSTRUCTIONS`, optional `PAYMENT_ACCOUNT_NAME`, `PAYMENT_CURRENCY`, which must match the quote currency). With any of them missing the customer sees "Payment instructions not configured" and cannot submit. A value containing the word DEMO makes the page show "DEMO - DO NOT TRANSFER MONEY". Use demo values only in the git-ignored `.env.local`; real details are the business owner's to supply.

**Customer submission** is `POST /api/payments` (multipart), a Route Handler rather than a Server Action: Server Actions accept 1 MB unless `serverActions.bodySizeLimit` is raised, and that limit is global to every action. The route checks origin, declared size (413), content type (415) and the session before it reads the body, then re-checks ownership, project status, the accepted quote and the file's real type (magic bytes). The receipt image is optional. The row carries no status or decision; the database sets and guards those.

**Administrator review** is at `/admin/payments` (no navigation link is shown: the pages and actions check the role on the server). Verify and reject are Server Actions that call `admin_verify_payment` / `admin_reject_payment` through the administrator's own session. Proof images are shown through 60-second signed links. Verification needs the amount received to equal the accepted quote total (also enforced by the database) and an explicit confirmation. The rejection reason is shown to the customer; the internal note is not.

Not part of this phase: starting generation and releasing assets. Verification does not start anything.

Tests: `tests/unit/payment-*.test.ts`, `tests/db/payment-proof-limits.test.ts`, the payment cases in `tests/db/index-usage.test.ts`, and `tests/live/payments-live.live.test.ts` (local stack).
