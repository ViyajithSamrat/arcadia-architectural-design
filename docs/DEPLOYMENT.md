# Deployment (Vercel + hosted Supabase)

The app is a standard Next.js project. A working deployment needs three things in place **before** the
application can sign anyone in or run a workflow: a hosted Supabase project with the migrations applied,
Supabase Auth configured, and the environment variables below set on Vercel. Until then the deployed site
loads, but sign-in and every workflow report themselves as not configured. Change production in this order.

## 1. A hosted Supabase project

The app keeps all durable state in Supabase: projects, briefs, quotes, payment claims, administrator
decisions, generation jobs, generated files, the usage ledger and audit events. Vercel functions are
stateless and short-lived, so this cannot move to local files or memory. Removing the database would
break every workflow after sign-in, so it stays.

Owner approval is needed for each step:

1. Create a Supabase project (region near the users, for example Mumbai).
2. Apply every migration in `supabase/migrations/` (12 at the time of writing; the last, `system_release_project`,
   is what lets finished concepts reach the customer automatically). Use `npx supabase link` and review
   `npx supabase db push --dry-run --linked --skip-vault` first. Do **not** apply anything in
   `supabase/proposed/`, and never use `--include-seed` or `--include-all`.
3. Load prices: publish rates from `/admin/pricing` after step 5. (`supabase/demo/pricing_rules.demo.sql` loads
   labelled "Demo rates" and must never be loaded into a real deployment.)
4. Auth → URL configuration:
   - Site URL: `https://<your-app>.vercel.app`
   - Redirect URLs: `https://<your-app>.vercel.app/auth/callback` (exact; the app never adds a query).
   - Minimum password length: 8.
5. Make the administrator: register on the deployed site, then in the SQL editor
   `insert into public.admin_users (user_id) values ('<that user id>');`. Nobody becomes an administrator
   any other way. Do not copy administrator rows from another database.
6. Email: Supabase's built-in mailer sends only a few emails an hour, so confirmation and reset emails can
   stop arriving in the middle of a demo. For a recorded demo, set up custom SMTP (Auth → SMTP), or sign in
   the demo accounts shortly before recording.

## Vercel environment variables (names only)

Set these for the **Production** environment. Values must never appear in Git, logs or screenshots.

| Name | Exposed to browser? | Needed for |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | yes (not secret) | Origin checks and email links. Must be the exact production URL |
| `NEXT_PUBLIC_SUPABASE_URL` | yes (not secret) | Supabase |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_…`) | yes (publishable key) | Supabase. Legacy fallback: `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `SUPABASE_SECRET_KEY` (`sb_secret_…`) | **no, server only** | Description save, ledger, clean-up. Legacy fallback: `SUPABASE_SERVICE_ROLE_KEY` |
| `PAYMENT_MODE`, `PAYMENT_UPI_ID`, `PAYMENT_ACCOUNT_NAME`, `PAYMENT_INSTRUCTIONS`, `PAYMENT_CURRENCY` | no | Payment page: the real account customers should pay |
| `PAYMENT_MOCK_GATEWAY` | no | `true` only for demonstrations: shows the simulated checkout. Leave empty in production |
| `GENERATION_AUTO_RELEASE` | no | Empty or `true`: finished real concepts reach the customer automatically. `false`: an administrator releases them |
| `GNANI_VOICE_ENABLED` and all `GNANI_*` STT settings, `VOICE_TRANSCRIPT_SECRET` | **no, server only** | Live speech-to-text |
| `GNANI_TTS_*`, `GNANI_CREDITS_PER_TTS_CHAR`, `GNANI_TTS_MAX_CHARS` | no | Spoken read-back (optional) |
| `OPENROUTER_API_KEY` | **no, server only** | Translation, live brief, live images |
| `OPENROUTER_TEXT_MODEL` | no | Translation and live brief |
| `TRANSLATION_MODE` | no | `live` for Tamil → English translation |
| `PROVIDER_MODE` | no | `live` for the OpenRouter brief **and** images; empty = labelled mocks |
| `OPENROUTER_IMAGE_MODEL` (+ optional `OPENROUTER_IMAGE_*`) | no | Live images (required when `PROVIDER_MODE=live`) |
| `AI_BRIEFS_PER_HOUR`, `OPENROUTER_DAILY_REQUEST_CAP`, `OPENROUTER_IMAGES_PER_HOUR`, `OPENROUTER_IMAGES_PER_DAY`, `MAX_GENERATION_IMAGES`, `PROVIDER_TIMEOUT_MS` | no | Spending caps (defaults apply when empty) |

Do not set `LIVE_SUPABASE` on Vercel (it is for local live tests only). A `NEXT_PUBLIC_*` value is
built into the browser bundle, so it must never hold a secret. The only `NEXT_PUBLIC_*` names are
the three above (plus the legacy anon key if it is used instead of the publishable key). The app
treats an `sb_secret_…` key or a legacy `service_role` key in a public variable as a configuration
error and reports Supabase as not configured; a publishable key in `SUPABASE_SECRET_KEY` is also
refused. When both the modern and the legacy name are set, the modern one is used. After changing
any variable, redeploy.

## Behaviour on Vercel that differs from local

- **Preview deployments** get their own URL, which does not match `NEXT_PUBLIC_APP_URL`. Their
  origin checks refuse sign-in and uploads. Demo on the production URL only.
- **Request body limit:** Vercel rejects function request bodies larger than 4.5 MB before the app
  sees them. The app therefore accepts payment receipt images and reference photos of at most 4 MB
  (`src/lib/uploads/limits.ts`; the form checks it before upload and the server again), so every
  accepted upload fits. The private bucket keeps its 5 MiB limit as the outer bound. Recordings (at
  most about 1 MB for 30 seconds) are fine.
- **In-memory limits:** the per-user request limits on transcription, translation and read-back are
  kept per function instance, so on Vercel they are weaker. The limits that control cost (the usage
  ledger, credit caps and one call in flight) live in the database and still apply.
- **Function duration:** generation starts by itself after an administrator verifies a payment. It runs
  after the response (`after()`) inside the verifying request's function, whose limit is set with
  `maxDuration = 300` on `/admin/payments/[paymentId]` and `/api/projects/[id]/status`. Live image
  generation waits up to `OPENROUTER_IMAGE_TIMEOUT_MS` per image (90 s by default), so keep
  `MAX_GENERATION_IMAGES` at 2 or less. Check that your Vercel plan allows a 300-second function; if it
  does not, lower `maxDuration` and `MAX_GENERATION_IMAGES` together.
- **Recovery:** if a run is cut off, the project stays `PAYMENT_VERIFIED` (the database records that
  generation is owed), and the customer's open project page re-triggers it through
  `/api/projects/[id]/status` after about 20 seconds. Every run is idempotent: a verified payment can never
  produce two jobs or two billed generations. An administrator can also start or retry from
  `/admin/generation`.
- **No local inbox:** the local mail catcher (`127.0.0.1:54324`) does not exist on Vercel; confirmation
  and reset emails go to real inboxes.

## Security headers and Content-Security-Policy (interim baseline)

Configured in `next.config.ts` and `src/lib/security/headers.ts`, with tests in
`tests/unit/security-headers.test.ts`. Every page and route handler sends the headers below, except
Next.js's own `/_next/static` files and `/_next/image` responses.

| Header | Value | Sent in |
|---|---|---|
| `Content-Security-Policy` | see below | production builds only |
| `X-Content-Type-Options` | `nosniff` | all builds |
| `X-Frame-Options` | `DENY` | all builds |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | all builds |
| `Permissions-Policy` | `camera=(), microphone=(self), geolocation=(), payment=(), usb=()` | all builds |

The microphone stays allowed for this site because voice input uses it. `next dev` sends no CSP,
because development needs `eval` and a hot-reload connection that the policy forbids.

The policy: `default-src 'self'`; `script-src` and `style-src` `'self' 'unsafe-inline'`; `img-src 'self' data:`
plus the Supabase origin; `font-src 'self'`; `media-src 'self' blob:`; `connect-src 'self'`; `frame-src`,
`object-src` and `frame-ancestors` `'none'`; `base-uri` and `form-action` `'self'`; and
`upgrade-insecure-requests` when the site is served over HTTPS.

**This is an interim baseline, not complete CSP hardening.** Because `script-src` allows `'unsafe-inline'`, the
policy does **not** stop an injected inline script from running. The app is built with Cache Components, so
its pages are prerendered shells that contain inline bootstrap scripts and inline `next/image` styles. A
per-request nonce cannot be added to a page that was built ahead of time, and hashes do not work because some of
those scripts differ per page. What the policy does block: framing (clickjacking), plugins, a changed `<base>`,
form posts to other sites, scripts and styles loaded from other origins, and images, media, fonts and
connections to origins that are not listed. The protection against script injection itself is still the code:
React escapes output, and `tests/unit/security-headers.test.ts` fails if raw HTML injection, `eval`, iframes,
remote `next/script`, a browser Supabase client, WebSocket or EventSource is added without reviewing the policy.
Nonce or hash based script rules would need the rendering decision revisited; that is an open item.

On Vercel:

- `NEXT_PUBLIC_SUPABASE_URL` is read at **build time**. Only its origin is added to `img-src`, so the signed
  links to private storage (receipts, reference photos, concept images) load. If it changes, redeploy.
  A missing or malformed value leaves `img-src` at `'self' data:`, and those images will not show.
- `NEXT_PUBLIC_APP_URL` must be the exact `https://` production URL. It switches on
  `upgrade-insecure-requests`; with an `http://` or missing value the directive is left out.
- **HSTS is not sent by the app.** It is deferred until Vercel's own HTTPS configuration has been checked on the
  deployed domain (`curl -sI https://<your-app>.vercel.app/`).
- After the first deployment, open the browser console on `/`, `/sign-in`, a project page and a results page:
  there must be no "Refused to ..." Content-Security-Policy messages.

## What is a labelled placeholder unless configured

| Feature | Without configuration | With configuration |
|---|---|---|
| Speech-to-text | Off, or the labelled mock (`GNANI_VOICE_ENABLED=mock`) | Live Gnani (`true` + all settings) |
| Tamil → English translation | Customer types the English | Live OpenRouter (`TRANSLATION_MODE=live`) |
| Brief writer | Labelled mock (deterministic, from the answers) | Live OpenRouter (`PROVIDER_MODE=live`) |
| Concept images | Labelled `MOCK — NOT A DESIGN` placeholders | Live OpenRouter (`PROVIDER_MODE=live` + image model) |
| Payment | Manual claim (or the labelled simulated checkout when `PAYMENT_MOCK_GATEWAY=true`); an administrator always verifies | No real gateway exists |
| Release to the customer | Placeholder images are never released automatically; an administrator must acknowledge them | Real output is released automatically unless `GENERATION_AUTO_RELEASE=false` |

## Checklist before announcing a public URL

- [ ] Hosted Supabase created, migrations applied, Auth URLs set, admin row inserted (owner approval)
- [ ] `PAYMENT_MOCK_GATEWAY` is empty and the payment instructions name the real account
- [ ] Vercel project created and production variables set (owner approval)
- [ ] Code committed and pushed (owner approval)
- [ ] On the production URL: sign in, all three journeys, translation, simulated payment, admin verify,
      generation, release, and a second account that cannot see the first one's project
- [ ] Spending caps set low; OpenRouter and Gnani credit balances checked in their dashboards
- [ ] On the production URL: the response carries the Content-Security-Policy and the other security headers,
      and the browser console shows no Content-Security-Policy violations (see the security headers section)
