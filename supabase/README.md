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
