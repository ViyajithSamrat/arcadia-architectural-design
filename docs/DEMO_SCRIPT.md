# Demo script: mock mode (local prototype, 2026-10-28)

A six-minute live walk through the whole journey: **customer submission → admin verification → mock
generation → preview → release.** It runs in **mock mode**: no AI or speech provider is called, nothing is
spent, and nothing depends on an API key, a quota or the internet. Everything a provider would normally
produce is labelled: briefs say "Demo/mock output", generated images say "MOCK — NOT A DESIGN", payments say
"simulated". Never present any of it as AI output or as a real transfer.

## 1. Start the app (Windows)

Docker Desktop must be running. From the project folder:

```powershell
npx supabase start          # the local database, sign-in and private storage (keeps its data)
npm run build               # only after code changes; the mode is read when the server starts, so switching
                            # between mock and live never needs a rebuild
```

Then start the server in mock mode. **PowerShell** (verified 2026-10-28):

```powershell
$env:PROVIDER_MODE = "mock"; $env:TRANSLATION_MODE = "off"; $env:GNANI_VOICE_ENABLED = "mock"; npx next start -p 3000
```

Other shells (the values were checked; the server itself was started from PowerShell):

```
cmd.exe:   set PROVIDER_MODE=mock&& set TRANSLATION_MODE=off&& set GNANI_VOICE_ENABLED=mock&& npx next start -p 3000
Git Bash:  PROVIDER_MODE=mock TRANSLATION_MODE=off GNANI_VOICE_ENABLED=mock npx next start -p 3000
```

Open `http://localhost:3000` and use `localhost` throughout (not `127.0.0.1`), so sign-in cookies match.

**Why three variables.** `.env.local` is left alone and holds live values (`PROVIDER_MODE=live`,
`TRANSLATION_MODE=live`, `GNANI_VOICE_ENABLED=true`). Variables set in the shell win over it (checked with
Next.js's own env loader). `PROVIDER_MODE=mock` by itself would leave transcript translation (OpenRouter) and
live Gnani voice switched on, so the demo command sets all three:

| Variable | Value | Effect |
|---|---|---|
| `PROVIDER_MODE` | `mock` | The brief is written by the built-in template (labelled), and images come from the placeholder generator (labelled). OpenRouter is not used. |
| `TRANSLATION_MODE` | `off` | No transcript translation. |
| `GNANI_VOICE_ENABLED` | `mock` | Voice shows its consent and recording screen with a fixed, labelled placeholder transcript. Live speech-to-text and spoken read-back are off (the summary is shown as text). |

Use non-empty values. PowerShell deletes a variable you set to `""`, and then the `.env.local` value would win again.

- The variables stay set in that PowerShell window. To return to the `.env.local` values, close the window or run
  `Remove-Item Env:PROVIDER_MODE, Env:TRANSLATION_MODE, Env:GNANI_VOICE_ENABLED`.
- Stop the server with Ctrl+C. If port 3000 is busy, find the owner with `Get-NetTCPConnection -LocalPort 3000 -State Listen`,
  read its command line, and stop it only if it is this project's `next start`.
- The OpenRouter key's expiry (29 Oct) does not matter in mock mode.

## 2. Confirm mock mode before presenting (30 seconds)

1. `http://localhost:3000/api/health`: `voice_input` is `mock_only` and `readback_audio` is `not_configured`. (Checked.)
2. Signed in as admin, `/admin/generation` shows the blue note **"Mock generation is on: test images only"**.
   (Seen in a browser on 2026-10-28, and covered by tests in all three modes.)
3. A newly created brief shows **"Demo/mock output"**, never "Drafted with AI". (Checked.)
4. The generate button reads **"Start mock generation"**. If it ever reads "Generate concept images (live, uses
   credits)", do not click it: stop the server and restart it with the command above.

## 3. What you need

- **Customer:** register in the browser on `/sign-in?mode=sign-up` (email and password; locally no confirmation email).
- **Administrator:** the dedicated demo admin account, in a second window (a private window or another profile).
  It is an ordinary account that the project owner added to `public.admin_users` by SQL; registering never grants admin rights.
- **Prices and payment details:** `supabase/demo/pricing_rules.demo.sql` loaded (quotes say "Demo rates"); the demo UPI
  values and `PAYMENT_MOCK_GATEWAY=true` in `.env.local` (these are what show the "Pay … (simulated)" button).

## 4. The script (live, about six minutes)

Every row works in mock mode. The **interior** journey is the one rehearsed end to end on 2026-10-28 and is the shortest,
so it is the safest live choice. The **new build on an empty plot** gives the richest result (two concept images and the
illustrative layout sketch): its administrator side and sketch were verified on 2026-10-28 on the prepared project, and its
customer side in mock mode on 2026-10-21 (earlier build). Row 3 is specific to the empty-plot journey.

| # | What to show | Route or action | Expected result | Account | If it fails |
|---|---|---|---|---|---|
| 1 | Three project types, no sign-in needed | `/` | Hero and three panels | none | Open `/new/empty-plot` |
| 2 | Self-service account | `/sign-in?mode=sign-up` → Create account | "You are signed in", the email in the header, no Admin tag | customer | Sign in with a demo account |
| 3 | Requirements with server-side validation (empty-plot journey) | `/new/empty-plot` → Start this project; enter built-up area `2` | "2 square feet is too small for the total floor area of a home…"; use `2400` and continue | customer | Enter believable values |
| 4 | Text description (voice is a labelled test mode) | Last step "In your own words" | The voice area says "Test mode: voice input uses a MOCK transcriber…"; type the description instead | customer | — |
| 5 | English brief | Save and review → Create my brief | Notice **"Demo/mock output"** (built-in template, not AI); your numbers kept; missing details listed; "Spoken read-back is not switched on in this setup" with the summary as text | customer | Reload and create again |
| 6 | Explicit approval | Tick "I have read this brief…" → Approve | Approve stays disabled until ticked; then the quote page | customer | — |
| 7 | Server-side itemized quote | Prepare my quote → Accept this quote | Lines, tax and total in ₹, labelled "Demo rates"; frozen once accepted. "Print or save as PDF" makes a one-page quote summary the customer can keep or send | customer | — |
| 8 | **Customer submission:** payment | Payment page → "Pay ₹… (simulated)" → "Simulate successful payment" | "Payment evidence submitted", pending review, **not** paid; reference `MOCKPAY-…` | customer | Use the manual form: a reference of 6 to 40 letters, digits or hyphens (for example `DEMO-REF-0001`), today's date, UPI |
| 9 | Nothing visible yet | `/projects/[id]/results` | "Your concept images appear here only after they have been reviewed and released to you." | customer | — |
| 10 | **Admin verification** | `/admin/payments` → open the `MOCKPAY-…` payment → Amount received = the quoted total → tick "I checked the receiving account…" → Verify payment | The page says "Simulated demo gateway: no money moved. Verify only for a demonstration."; a wrong amount is refused; then "Payment verified" and an audit entry | **admin** | Show Reject (a reason is required) |
| 11 | **Mock generation** | Open `/admin/generation/<project id>` (copy the id from the customer window's address bar) → Start mock generation. The queue at `/admin/generation` also works, newest first, but it holds about 14 older test projects that look alike | "Images created. They are private and have not been released." | admin | Reload the page; use a prepared project (section 6) |
| 12 | **Preview** | Same page | Gallery of placeholder images, each marked "MOCK — NOT A DESIGN", with the warning and "Only administrators can see these until they are released" (new build: the layout sketch too) | admin | — |
| 13 | **Release** | Same page → tick both confirmations → "Release … to the customer" | "Released. The customer can now see these images." | admin | — |
| 14 | Customer sees the result | `/projects/[id]/results` | The images (still labelled MOCK) with a **Download** link under each, the "conceptual illustrations only" notice, the layout sketch | customer | Reload for fresh image links |
| 15 | Isolation | A second customer opens that project's URL; any customer opens `/admin/payments` | "Page not found"; "You do not have access to this area" | other customer | — |
| 16 | Security proof | `npx vitest run tests/db` | The database rules: no generation before verified payment, no cross-customer access, release only by an admin (215 tests at the last run) | — | Show the test file names |

## 5. What has been verified, and how

| What | When | How | Result |
|---|---|---|---|
| Mock startup command | 2026-10-28 | The three assignments run from PowerShell, cmd and Git Bash into a Node probe; Next.js's env loader run with and without them | Right values reach the server, and the shell wins over `.env.local` |
| Customer half in mock mode | 2026-10-28 | Browser, new project on the documented command, with a proxy that recorded and refused any outbound connection | New project → mock brief ("Demo/mock output", stored `mock`) → approval → quote ("Demo rates") → simulated payment pending. **0 outbound attempts**; OpenRouter usage counter and usage ledger unchanged |
| Administrator half in mock mode, on the documented command | 2026-10-28 | Browser (the project owner signed the admin in), on a new project, behind the proxy that records and refuses any outbound connection | The blue "Mock generation is on" note shown; a wrong amount refused, then verified; mock generation (job `mock/SUCCEEDED`, one private image); preview through signed links; release with both confirmations; the owner sees the image labelled MOCK; a stranger gets "Page not found". **0 outbound attempts** in the whole admin half; usage counter and ledger unchanged; no existing record changed |
| Administrator half, three older fixtures | 2026-10-28 (earlier session) | Browser, server started in mock mode | Verification (a wrong amount refused first), rejection with a reason, mock generation, private preview, release, owner's view, stranger and signed-out denial, 16 direct requests refused |
| Banner wording, all three modes | 2026-10-28 | Unit tests, production build, prerendered output inspected | Asserted for mock, live and live-unavailable; nothing baked in at build time |
| All three journeys end to end in mock mode | 2026-10-21 | Browser, earlier build | Passed |

The proxy used for the egress check is test scaffolding outside the repository.

## 6. Prepared projects (fallback)

If something breaks, these are ready (all in the local database, owned by throwaway accounts whose logins are not stored in the repository, so the admin screens are the way to show them):

| Journey | Project | State |
|---|---|---|
| New build on an empty plot | `04e96bc2-8011-48fe-9f5f-3100839e2da5` | Payment verified, mock images generated and released |
| Landscaping | `f8de56c8-18f2-4454-b92e-ba8255c80c88` | Payment rejected with a reason |
| Interior | `f6a6da95-cc7d-4059-9f6f-a7eb5c6d715b` | Payment pending review: usable for steps 10 to 13 |
| Interior (the 2026-10-28 rehearsal) | `eff877a9-b99f-4502-8d09-b946017e40e3` | Simulated payment verified, one mock image generated and released |

## 7. If something goes wrong

- **A page sits on "Loading…":** a browser window that is minimized or completely covered stops rendering new pages. Bring it to the front.
- **The generate button says "(live, uses credits)", or the blue note says live:** you are not in mock mode. Stop, and restart with the command in section 1.
- **The server will not start:** the project needs `.next` (run `npm run build`) and the local database (`npx supabase status`).
- **Sign-in link or reset email:** local emails arrive in Mailpit at `http://127.0.0.1:54324`.

## 8. Say this, and nothing stronger

- Payment evidence is a claim for a person to check. `MOCKPAY-…` references are demo data: nothing is paid.
- Generation is impossible before an administrator verifies the payment (the database refuses it). Images stay private until an administrator releases them, project by project.
- In this mode no AI model made the brief or the images; they are labelled placeholders. Concepts are never construction drawings, CAD, BIM or approved plans.

## 9. Not shown in this demo

Live AI briefs and images (a separate, deliberate test), Google sign-in (built, not configured), real email delivery,
Gnani speech-to-text and spoken read-back (the voice step is the labelled test mode), real payments, hosted deployment.
