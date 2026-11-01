# Environment variables

Copy `.env.example` to `.env.local` for local work; set the same names in the Vercel project for production. Every value is blank by default and the app runs with all of them blank: a feature whose settings are missing reports itself as unavailable instead of pretending to work.

Rules that apply to all of them:

- **Secrets stay on the server.** Never put a secret in a `NEXT_PUBLIC_*` variable: those are compiled into the browser bundle.
- Values are validated by `src/lib/env/schema.ts`; an invalid value is reported by *name only*, never by value.
- The Supabase CLI also reads `.env.local`, so keep it to plain `KEY=value` lines (no comments, no byte-order mark).
- Restart the dev server (and redeploy on Vercel) after changing a variable. `NEXT_PUBLIC_*` values are read at build time.
- Do not set `LIVE_SUPABASE` or `LIVE_PROVIDER_SMOKE` on Vercel; they enable local-only test suites.

Legend: **S** = server only (secret). **P** = public (sent to the browser; not secret).

## Application

| Variable | | Description |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | P | The exact public origin (for example `https://example.vercel.app`). Sign-in and upload origin checks, email links and the Content-Security-Policy `upgrade-insecure-requests` directive use it. Set it in every deployment. |
| `PROVIDER_MODE` | | `mock` (or empty) uses labelled placeholder generators. `live` uses OpenRouter for the brief and images and needs the OpenRouter settings; an incomplete live configuration reports "unavailable", never a placeholder. |
| `GENERATION_AUTO_RELEASE` | | Empty or `true`: finished real (non-placeholder) concepts are released to the customer automatically. `false`: an administrator releases them. Placeholder output always needs an administrator. |
| `MAX_GENERATION_IMAGES` | | Images per generation request (1 to 4, default 2). It can only lower the built-in ceiling; the views each project type needs limit it further. |

## Supabase

| Variable | | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | P | Project URL. Also read at build time to allow signed Storage image links in the Content-Security-Policy. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | P | The publishable key (`sb_publishable_…`). Preferred. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | P | Legacy anon key. Fallback only (the local Docker stack prints this form). Ignored when the publishable key is set. |
| `SUPABASE_SECRET_KEY` | S | The secret key (`sb_secret_…`). Preferred. Used for trusted server work after authorization. |
| `SUPABASE_SERVICE_ROLE_KEY` | S | Legacy service-role key. Fallback only. Ignored when the secret key is set. |

A secret key in a public variable, or a publishable key in a secret variable, is rejected as a configuration error. Without the secret key the actions that need trusted access (saving the description step, generation, the usage ledger) fail safely and write nothing.

## OpenRouter (server only)

| Variable | | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | S | API key. |
| `OPENROUTER_BASE_URL` | | Override the API base URL. |
| `OPENROUTER_TEXT_MODEL` | | Model for the brief wording and translation. |
| `OPENROUTER_TEXT_REASONING_EFFORT` | | `none`, `minimal` or `low`; empty = the model default. |
| `TRANSLATION_MODE` | | Empty/`off`: the customer types the English version of a non-English transcript. `live`: translate with the text model. |
| `OPENROUTER_IMAGE_MODEL` | | Image model (`author/slug`). Required when `PROVIDER_MODE=live`. |
| `OPENROUTER_IMAGE_RESOLUTION` | | `1K` (default), `2K`, `4K`. |
| `OPENROUTER_IMAGE_ASPECT_RATIO` | | Default `16:9`. |
| `OPENROUTER_IMAGE_FORMAT` | | `jpeg` (default), `png`, `webp`. Stored files must stay within 5 MiB. |
| `OPENROUTER_IMAGE_TIMEOUT_MS` | | Per image; default 90000, range 10000–180000. |
| `OPENROUTER_IMAGES_PER_HOUR` | | Per customer; default 6. |
| `OPENROUTER_IMAGES_PER_DAY` | | All customers; default 20. |
| `OPENROUTER_IMAGE_REFERENCES` | | `true` sends up to three customer reference photos to the image service; anything else never does. |
| `OPENROUTER_HTTP_REFERER`, `OPENROUTER_APP_TITLE` | | Optional attribution headers. |
| `AI_BRIEFS_PER_HOUR` | | Per-customer text requests per hour. |
| `OPENROUTER_DAILY_REQUEST_CAP` | | All-customer text requests per day. |
| `PROVIDER_TIMEOUT_MS` | | Provider call timeout. |

## Gnani voice (server only)

Voice is off unless `GNANI_VOICE_ENABLED=true` **and** every setting it needs is present.

| Variable | | Description |
|---|---|---|
| `GNANI_VOICE_ENABLED` | | Empty: off. `mock`: a labelled placeholder transcriber (no network, no credits). `true`: live. |
| `GNANI_API_KEY` | S | API key. |
| `GNANI_BASE_URL` | | API base URL. |
| `GNANI_STT_ENDPOINT`, `GNANI_TTS_ENDPOINT` | | Endpoint paths. |
| `GNANI_TTS_MODEL`, `GNANI_TTS_VOICE` | | Text-to-speech model and a voice that belongs to it. |
| `GNANI_LANGUAGES` | | Languages offered (read-back also needs `en-IN`). |
| `GNANI_STT_MAX_SECONDS`, `GNANI_TTS_MAX_CHARS` | | Per-request limits. |
| `GNANI_CREDITS_PER_STT_SECOND`, `GNANI_CREDITS_PER_TTS_CHAR` | | Credit rates from your Gnani account. |
| `GNANI_MAX_CREDITS_PER_REQUEST`, `GNANI_CUSTOMER_CREDITS_PER_HOUR` | | Spending limits. |
| `GNANI_BUDGET_CREDITS` | | Total budget; can never exceed the hard ceiling of 5,000 whatever is set. |
| `VOICE_TRANSCRIPT_SECRET` | S | Random string of at least 32 characters that signs transcripts so a saved description can be told apart from typed text. Required for live speech-to-text. |

Provider facts and verification notes: [PROVIDERS.md](PROVIDERS.md).

## Payment display

| Variable | | Description |
|---|---|---|
| `PAYMENT_MODE` | | `manual`. Display only; nothing here moves money. |
| `PAYMENT_UPI_ID`, `PAYMENT_ACCOUNT_NAME`, `PAYMENT_INSTRUCTIONS` | | What the customer is told to pay. |
| `PAYMENT_CURRENCY` | | Must match the quote currency. |
| `PAYMENT_MOCK_GATEWAY` | | `true` adds a **simulated** checkout for demonstrations; a simulated success only records a pending claim an administrator must still verify. Leave empty in production. |

## Reserved (validated but not read by the application)

`APP_BASE_URL`, `ADMIN_EMAILS` (grants nothing; administrators are rows in `public.admin_users`), `SUPABASE_DB_URL`, `SUPABASE_STORAGE_BUCKET`, `GNANI_STT_MODEL`, `LOG_LEVEL`, `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_SECONDS`. Setting them has no effect today.
