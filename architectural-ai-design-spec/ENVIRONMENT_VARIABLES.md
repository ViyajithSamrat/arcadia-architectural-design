# Environment Variables & API Setup Guide

> **Purpose:** Central inventory of the environment variables expected
> for the Architectural AI Design Web Prototype.
>
> **Important:** All values are intentionally blank. Fill them only when
> you configure each service.
>
> **Status legend** - **Required** --- needed for the corresponding
> feature to work. - **Conditional** --- needed only if that
> integration/feature is enabled. - **Proposed name** --- a
> project-level variable name; confirm it matches the actual
> SDK/provider integration before use.

## 1. How to use this guide

1.  Copy `.env.example` to `.env.local` for local development.
2.  Add values only when you have created/configured the relevant
    service.
3.  Keep `.env.local` out of Git. Never paste real secrets into source
    code, documentation, screenshots, or client-side variables.
4.  Configure the same variables separately in your deployment
    provider's server-side environment settings.
5.  Restart the development server after changing environment variables.
6.  Validate required variables at application startup and provide clear
    errors when a required value is missing.

**Never prefix secrets with `NEXT_PUBLIC_`.** In Next.js, variables with
that prefix are exposed to browser code.

## 2. Application

  -----------------------------------------------------------------------
  Variable                Status                  Purpose
  ----------------------- ----------------------- -----------------------
  `NODE_ENV`              Runtime-managed         Usually managed by
                                                  Next.js / deployment
                                                  platform; do not
                                                  normally set manually.

  `NEXT_PUBLIC_APP_URL`   Required                Public base URL used
                                                  for links and
                                                  redirects, e.g. local
                                                  development or deployed
                                                  app URL. Not a secret.

  `APP_BASE_URL`          Conditional             Server-side canonical
                                                  URL where needed for
                                                  callbacks, emails, or
                                                  server-generated links.
                                                  Keep aligned with the
                                                  public URL.

  `ADMIN_EMAILS`          Conditional             Comma-separated
                                                  allowlist of
                                                  administrator email
                                                  addresses if the app
                                                  uses email-based admin
                                                  allowlisting. Must not
                                                  be the only
                                                  authorization layer.

  `PROVIDER_MODE`         Conditional             `mock` or `live`.
                                                  Chooses between clearly
                                                  labelled mock adapters
                                                  and verified live
                                                  providers. Unset behaves
                                                  as `mock`. `live` is
                                                  valid only for providers
                                                  verified with real
                                                  credentials. Proposed in
                                                  `02_TRD.md` section 2.4.
  -----------------------------------------------------------------------

## 3. Supabase --- database, authentication, and storage

Create a Supabase project and retrieve its project URL and API keys from
the Supabase dashboard.

  ---------------------------------------------------------------------------------
  Variable                          Status                  Purpose
  --------------------------------- ----------------------- -----------------------
  `NEXT_PUBLIC_SUPABASE_URL`        Required                Supabase project URL
                                                            used by the browser
                                                            client. Not a secret.

  `NEXT_PUBLIC_SUPABASE_ANON_KEY`   Required                Supabase
                                                            publishable/legacy anon
                                                            key for browser-side
                                                            operations, subject to
                                                            correct RLS policies.
                                                            Use the key type
                                                            supplied by your
                                                            project.

  `SUPABASE_SERVICE_ROLE_KEY`       Conditional / highly    Server-only elevated
                                    sensitive               key for trusted
                                                            administrative
                                                            operations, if
                                                            required. Never expose
                                                            to browser code or
                                                            `NEXT_PUBLIC_*`. Prefer
                                                            least-privilege
                                                            alternatives when
                                                            available.

  `SUPABASE_DB_URL`                 Conditional / highly    Direct database
                                    sensitive               connection string, only
                                                            if a server-side tool
                                                            or migration workflow
                                                            requires it. Keep
                                                            server-side.

  `SUPABASE_STORAGE_BUCKET`         Conditional             Private storage bucket
                                                            name for payment
                                                            evidence and generated
                                                            design assets, if
                                                            configured through
                                                            environment.
  ---------------------------------------------------------------------------------

**Security requirements:** Enable and test Row Level Security (RLS),
ownership checks, and private Storage policies. A frontend check or
hidden button is not authorization. Do not use a service-role key to
bypass policies in ordinary customer requests.

## 4. OpenRouter --- text / image model access

OpenRouter is the proposed model gateway. Confirm the selected model's
current capabilities, input/output modalities, limits, and pricing
before implementation. Do not assume every model supports image
generation.

  ---------------------------------------------------------------------------
  Variable                    Status                  Purpose
  --------------------------- ----------------------- -----------------------
  `OPENROUTER_API_KEY`        Required for OpenRouter Server-only API key.
                              features                Never expose it to the
                                                      browser.

  `OPENROUTER_BASE_URL`       Conditional             Override only if
                                                      required by the
                                                      official
                                                      client/integration;
                                                      otherwise use the
                                                      provider's documented
                                                      default.

  `OPENROUTER_TEXT_MODEL`     Required for text       Model identifier for
                              generation              brief generation,
                                                      structured quotes, and
                                                      other text tasks.

  `OPENROUTER_IMAGE_MODEL`    Conditional             Model identifier only
                                                      if the chosen
                                                      model/provider path
                                                      actually supports the
                                                      required
                                                      image-generation
                                                      workflow. Verify before
                                                      use.

  `OPENROUTER_HTTP_REFERER`   Conditional             Optional attribution
                                                      header if required by
                                                      the integration. Use
                                                      the real deployed URL
                                                      when configured.

  `OPENROUTER_APP_TITLE`      Conditional             Optional application
                                                      attribution/title
                                                      header if supported by
                                                      the integration.
  ---------------------------------------------------------------------------

If image generation uses a separate provider or endpoint, add
provider-specific variables only after the architecture decision is
made. Do not place image-provider credentials in client-side variables.

## 5. Gnani --- speech-to-text and text-to-speech

The project specification proposes Gnani Prisma for speech-to-text (STT)
and Gnani Timbre for text-to-speech (TTS). Obtain the correct
credentials, endpoint, API version, and request format from the
provider's current documentation or account onboarding materials.

  -----------------------------------------------------------------------
  Variable                Status                  Purpose
  ----------------------- ----------------------- -----------------------
  `GNANI_API_KEY`         Conditional             Server-only credential,
                                                  if the selected Gnani
                                                  API uses an API key.

  `GNANI_BASE_URL`        Conditional             Provider API base URL,
                                                  copied from current
                                                  official documentation.

  `GNANI_STT_ENDPOINT`    Conditional             Endpoint/path for the
                                                  selected speech-to-text
                                                  integration, if
                                                  configured separately.

  `GNANI_TTS_ENDPOINT`    Conditional             Endpoint/path for the
                                                  selected text-to-speech
                                                  integration, if
                                                  configured separately.

  `GNANI_STT_MODEL`       Conditional             Model/service
                                                  identifier if required
                                                  by the provider.

  `GNANI_TTS_MODEL`       Conditional             Model/voice/service
                                                  identifier if required
                                                  by the provider.

  `GNANI_TTS_VOICE`       Conditional             Voice identifier if
                                                  supported and required.
  -----------------------------------------------------------------------

These names are proposed placeholders, not a claim about Gnani's exact
authentication scheme or API field names. Keep only variables the chosen
integration actually needs.

## 6. Payments --- manual verification prototype

The current prototype uses customer-submitted payment evidence and
manual administrator verification; it does **not** require a payment
gateway secret unless a gateway is added later.

  --------------------------------------------------------------------------
  Variable                   Status                  Purpose
  -------------------------- ----------------------- -----------------------
  `PAYMENT_MODE`             Required for payment    Suggested values:
                             workflow                `manual` for the
                                                     current prototype.
                                                     Validate allowed values
                                                     in application code.

  `PAYMENT_UPI_ID`           Conditional             Business UPI ID shown
                                                     to the customer, if
                                                     using UPI. This is
                                                     configuration, not an
                                                     API secret.

  `PAYMENT_ACCOUNT_NAME`     Conditional             Payee/account display
                                                     name shown in payment
                                                     instructions.

  `PAYMENT_INSTRUCTIONS`     Conditional             Public instructions for
                                                     offline/manual payment.
                                                     Never include bank
                                                     login details or
                                                     sensitive credentials.

  `PAYMENT_CURRENCY`         Conditional             Currency code used by
                                                     the application,
                                                     e.g. `INR`, if
                                                     configurable.

  `PAYMENT_GATEWAY_SECRET`   Not used in current     Reserve only if a
                             scope                   future approved payment
                                                     gateway requires a
                                                     server-side secret. Do
                                                     not create or populate
                                                     it for manual
                                                     verification.

  `PAYMENT_WEBHOOK_SECRET`   Not used in current     Reserve only if a
                             scope                   future payment provider
                                                     uses signed webhooks.
  --------------------------------------------------------------------------

**Important:** A customer uploading a screenshot is not proof that
payment has settled. Only an authorized server-side/admin verification
action should mark a payment verified and permit generation.

## 7. Optional operational services

Do not configure these unless the implementation plan explicitly adopts
them.

  -----------------------------------------------------------------------------
  Variable                      Status                  Purpose
  ----------------------------- ----------------------- -----------------------
  `SENTRY_DSN`                  Optional                Error monitoring
                                                        service DSN, if error
                                                        monitoring is added.
                                                        Check whether the
                                                        selected DSN is
                                                        intended to be public
                                                        or server-only.

  `LOG_LEVEL`                   Optional                Application logging
                                                        level, if supported by
                                                        the logger.

  `RATE_LIMIT_MAX_REQUESTS`     Optional                Proposed application
                                                        rate-limit setting if
                                                        rate limiting is
                                                        implemented.

  `RATE_LIMIT_WINDOW_SECONDS`   Optional                Proposed rate-limit
                                                        window in seconds.
  -----------------------------------------------------------------------------

No scheduled jobs are part of the approved scope, so no `CRON_SECRET` is
defined. Add one only if a future approved phase introduces scheduled jobs.

## 8. Example blank environment template

Use the companion `.env.example` as the copyable template. Keep its
values blank and copy it to `.env.local` before entering your
credentials.

## 9. Variables that must not be committed

-   `.env.local`
-   `.env`
-   `.env.production`
-   Any file containing actual API keys, access tokens, service-role
    keys, database URLs, webhook secrets, or private credentials.

The `.env.example` file with empty values is safe to commit, provided no
real credentials are added.

Recommended `.gitignore` entries:

``` gitignore
.env
.env.*
!.env.example
```

If your repository already has a `.gitignore`, merge these rules
carefully and ensure local and production secret files remain ignored.

## 10. Before implementation: verify each integration

-   [ ] Supabase project created; URL and keys identified.
-   [ ] RLS and private storage policies planned and tested.
-   [ ] OpenRouter key created and selected text model verified.
-   [ ] Image-generation provider/model capability confirmed.
-   [ ] Gnani API access, endpoint, authentication, and supported
    STT/TTS services confirmed.
-   [ ] Admin authorization approach agreed and enforced server-side.
-   [ ] Manual payment instructions and verification workflow agreed.
-   [ ] Deployment platform selected and environment-variable
    configuration understood.
-   [ ] `.env.local` is ignored by Git.
-   [ ] No secrets are present in browser bundles, logs, commits, or
    Markdown documentation.

## 11. Instructions for Claude Code

Before wiring these variables into the app:

1.  Read this guide and `.env.example`.
2.  Compare the variables with the approved architecture plan and the
    actual SDK/API documentation.
3.  Identify variables that are truly required, optional, redundant, or
    unsupported.
4.  Do not invent provider endpoints, model IDs, authentication headers,
    or response formats.
5.  Add server-side environment validation using the project's existing
    conventions.
6.  Ensure secrets are only accessed in server-side code.
7.  Keep all values blank until the developer supplies them.
8.  Never block unrelated development just because an optional
    integration credential is missing; provide a safe mock or disabled
    state where appropriate.
9.  Do not mark payment as verified from client-submitted data.
10. Report any required variable not documented here before implementing
    its integration.
