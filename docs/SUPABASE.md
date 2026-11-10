# Supabase

ARCADIA keeps all durable state in Supabase: PostgreSQL (with row level security and workflow triggers), Auth, and one private Storage bucket.

## Migrations

All schema changes are forward-only SQL files in `supabase/migrations/`, applied in filename order. Each has a matching rollback in `supabase/rollbacks/` (a rollback removes protection, so read it before using it).

| # | File | Purpose |
|---|---|---|
| 1 | `…helpers_and_admin` | `is_admin()`, the `admin_users` table, shared helpers |
| 2 | `…core_tables` | projects, quotes, payments, jobs, assets, pricing, settings, audit events, indexes |
| 3 | `…workflow_guards` | status-transition rules, payment gate, release rules, audit triggers, the admin functions |
| 4 | `…rls_and_grants` | row level security policies and table/column grants |
| 5 | `…storage` | the private `project-files` bucket and its policies |
| 6 | `…payment_proof_limits` | bucket size and type limits |
| 7 | `…ai_usage` | usage ledger and budget guard |
| 8 | `…restrict_transcript_columns` | customers cannot write transcript fields |
| 9 | `…ai_usage_images` | image metering |
| 10 | `…insert_generated_asset` | the checked write path for generated files |
| 11 | `…serialize_stale_clearing` | race-free clearing of abandoned jobs |
| 12 | `…system_release_project` | service-role-only automatic release of finished real output |

`supabase/proposed/` holds migrations that are **deliberately not applied** and are not part of any deployment.

### Applying to a hosted project

Use the Supabase CLI through `npx` (it is not a project dependency). Authenticate in your own terminal; never paste tokens or passwords into a chat or a file.

```bash
npx --yes supabase@2.122.0 login
npx --yes supabase@2.122.0 projects list                      # find the project reference and region
npx --yes supabase@2.122.0 link --project-ref <reference>     # enter the database password at the prompt
npx --yes supabase@2.122.0 migration list --linked            # a new project has no history
npx --yes supabase@2.122.0 db push --dry-run --linked --skip-vault
```

Review the dry run: it must list exactly the migrations above, in order. Then, once you approve, run the same command without `--dry-run`. `--skip-vault` stops the CLI updating Vault secrets from `config.toml`. Never use `--include-seed`, `--include-all`, `db reset`, `config push` or `migration repair` against a hosted project.

## Auth checklist (hosted project)

- **Site URL:** the exact production URL.
- **Redirect URLs:** `<production URL>/auth/callback` (exact).
- **Minimum password length:** 8.
- **Email confirmation:** decide whether new users must confirm. If they must, configure custom SMTP: the built-in mailer allows only a few emails an hour, so confirmation and reset mail can stop arriving.
- **Sign-up:** decide whether registration is open.
- **Google sign-in:** optional; the code supports it, but it needs credentials configured in Supabase.
- **First administrator:** register on the deployed site, then in the SQL editor:
  `insert into public.admin_users (user_id) values ('<that user id>');`
  Nobody becomes an administrator automatically. Do not copy administrator rows or users from a development database.
- **Pricing:** sign in as the administrator and publish rates at `/admin/pricing`. The demo pricing file is for local use only.

## Row level security and Storage

RLS is enabled on every application table, and `anon` has no table grants.

| Data | Customer | Administrator |
|---|---|---|
| Own projects | read; update draft content only | read all |
| Quotes | read own | read all |
| Payments | read own; insert one pending claim | read all; decide through `admin_*` functions |
| Generation jobs | no access (provider metadata stays server-side) | read all |
| Generated assets | read only rows marked released, for their own projects | read all |
| `pricing_rules`, `site_settings` | none | manage |
| `admin_users`, `project_status_transitions` | none | none through the API (the administrator role is granted by SQL and read only by `is_admin()`) |
| `audit_events` | none | read; nobody can edit |

Storage policies mirror this: receipts and reference photos are owner-readable, generated files are readable by the owner only after release, and administrators can read everything. The service-role key never reaches the browser, and `NEXT_PUBLIC_` variables must never hold it.

## Local development

```bash
npx supabase start -x studio,realtime,imgproxy,edge-runtime,logflare,vector,supavisor,postgres-meta
npx supabase status -o env
```

Keep `.env.local` to plain `KEY=value` lines (no comments, no byte-order mark), because the CLI reads it too. The mail catcher at `127.0.0.1:54324` receives local confirmation and reset emails.

To add an administrator locally, register through the app and insert the user's id into `public.admin_users` as above.
