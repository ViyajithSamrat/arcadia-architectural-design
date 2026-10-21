# Five-minute demo script (local prototype, mock providers)

Source: `architectural-ai-design-spec/09_DEMO_SCRIPT.md`. This script keeps its seven steps and order and adds timings, routes and the state of each step as of 2026-10-21. Where a step cannot be shown truthfully today, it has a **labelled fallback**. The original acceptance wording is not softened.

**Ground rules for the presenter**
- **Say "mock" out loud** whenever mock output is on screen. Voice transcripts, the brief writer and concept images are all mocks; no live AI provider is used.
- **Never present a payment as real.** Use clearly labelled demo payment details and a test reference.
- **This is not a hosted product.** The demo runs on `http://localhost:3000` against a local Supabase stack.
- **Nothing is construction-ready.** Images and the layout sketch are concepts, not CAD, construction drawings or approved plans.

**What each step's status label means**
- **Verified (earlier, local):** worked in a local browser in an earlier session, on code not changed since.
- **Mock-only:** works, but shows labelled mock output.
- **Browser-verified (2026-10-21):** exercised in a headless Edge browser against the local development server (`next dev`), using the real UI and the local Supabase stack. All three journeys were run end to end. This was **not** repeated against the production build (`next start`), on a phone or at mobile width.
- **Needs browser check:** implemented and tested offline, but never exercised in a browser. Rehearse it first.

## Before the demo (not part of the five minutes)

Each of these needs the owner's approval in this project (it starts services or writes local data). See the README runbook for the commands.

1. **Services.** Start the local Supabase stack and the app (`npm run build && npx next start -p 3000`). Set `GNANI_VOICE_ENABLED=mock` and leave `PROVIDER_MODE` unset.
2. **Prices.** Load `supabase/demo/pricing_rules.demo.sql`. It sets `pricing_mode` to demo, so every quote says "Demo rates". Do **not** demo with rates entered on `/admin/pricing` unless demo mode is on, or the quote would look like real pricing.
3. **Payment details.** Set demo payment display values (`PAYMENT_MODE=manual`, a UPI ID or instructions containing the word "demo", `PAYMENT_CURRENCY=INR`).
4. **Accounts.** Create two accounts in two browser profiles: a customer, and an administrator added to `public.admin_users`. Magic links arrive at `http://127.0.0.1:54324`.
5. **Prepared projects**, because generation and release do not fit into five minutes live:
   - **A.** An empty-plot project already **released**: mock images plus the layout sketch.
   - **B.** An interior or landscape project already **released**.
   - **C.** An empty-plot project at **"Quote ready"**, for the payment step.
   - **D.** A project at **"Payment evidence submitted"**, for the admin step.
   - **E.** An empty-plot **draft** with the space, rooms and preferences steps answered, for the voice and brief step. The description can only be changed while a project is a draft or its brief is under review.
6. **Rehearse every "needs browser check" step once.** If one fails, use its fallback or drop it, and say so.

## Local demo records (this machine's local database only)

Created on 2026-10-21 through the real UI, with demo data (the answers carry the label "DEMO E2E"), as the account `demo-e2e-mvi2xal6@example.test`. Each ran create, brief, quote, payment evidence, administrator verification, mock generation and release, and is now **released**, so they serve as finished-results examples:

| Journey | Project ID |
|---|---|
| New build on an empty plot | `d8ba4423-726c-4f1d-81ab-cd105b409a97` |
| Interior refresh | `f8551043-29e4-46ea-ad27-d01f7aaa863f` |
| Landscaping | `c1e2cff2-be25-432b-829d-ed3abf642486` |

They are local records and do not exist anywhere else. To demonstrate the live steps (quote, payment, verification, generation, release) you still need fresh projects at the earlier states listed above.

## Timed script

| Time | Step (from 09) | Screen | Status |
|---|---|---|---|
| 0:00–0:25 | 1. Landing | `/` then `/new/empty-plot` | Verified (earlier, local) |
| 0:25–1:20 | 2. Voice and brief | `/projects/[E]/edit` (description step), then `/projects/[E]/brief` | Voice: **mock-only**; brief: **mock-only**; read-back summary: **browser-verified (2026-10-21)**; voice recording itself: not browser-verified with a real microphone |
| 1:20–2:10 | 3. Layout sketch and concept images | `/projects/[A]/results` | Images: **mock-only**; sketch: **browser-verified (2026-10-21)** |
| 2:10–2:45 | 4. Interior or landscape | `/new/interior`, then `/projects/[B]/results` | Uploads: **not available (fallback)**; images: **mock-only** |
| 2:45–3:40 | 5. Pricing and payment | `/projects/[C]/quote`, then `/payment` | Verified (earlier, local); demo rates and demo payment details |
| 3:40–4:35 | 6. Admin verification and release | `/admin/payments`, `/admin/generation/[A or D]` | Payment review: verified (earlier, local). Verify, start mock generation and release: **browser-verified (2026-10-21)**, mock images |
| 4:35–5:00 | 7. Security and limits | `/admin/generation/[C]` and a terminal | Screen: **browser-verified (2026-10-21)**; tests: offline, verified |

## Step by step

### 1. Landing — 0:00 to 0:25 (25 s)

- **Do:** Open `/`. Point out the three services. Click the new-build card, which opens `/new/empty-plot`.
- **You see:** Three distinct project types and the concept-only disclaimer.
- **Say:** "Three journeys: a new build on an empty plot, an interior refresh and a garden. Everything you'll see is a concept, not a construction drawing."
- **Status:** Verified (earlier, local).

### 2. Voice and brief — 0:25 to 1:20 (55 s)

- **Do:** On project E's description step (`/projects/[E]/edit`), tick the consent box, pick a language, then either click **Start recording** and **Stop and send**, or **Choose a WAV file**.
- **You see:** A transcript box containing `[MOCK TRANSCRIPT — no speech service was used] …` and a "MOCK" notice.
- **Say:** "Voice capture works end to end in the app, but the speech service is a labelled mock: it doesn't listen to the audio. Live Gnani transcription is switched off until the account details are confirmed. The app also refuses to save this placeholder as the description, so I'll type mine."
- **Do:** Type a short description and save. On `/projects/[E]/brief`, click **Create my brief**. Correct a room count via "Change my answers" if time allows (the spec's "correct a room count"). Changing an answer clears the brief, so click **Create my brief** again. Show **What you told us**, the **Read-back summary** and the editable brief.
- **You see:**
  - a "Demo/mock output" notice on the brief;
  - the read-back summary as text, with the note that listening isn't available in this version.
- **Say:** "The brief is built from the customer's own answers; nothing is invented, and missing details are listed. Spoken read-back isn't connected yet, so the summary is shown as text."
- **Status:** Voice and brief are mock-only. The read-back summary was browser-verified on 2026-10-21. Voice capture was checked only in a headless browser with a fake microphone, never with a real microphone.
- **Fallback:** If the microphone is unavailable, skip recording and say "text-only works for every journey" (PR-003).

### 3. Layout sketch and concept images — 1:20 to 2:10 (50 s)

- **Do:** Open `/projects/[A]/results`, the released empty-plot project.
- **You see:**
  - the concept disclaimer;
  - images stamped **"MOCK — NOT A DESIGN"**;
  - the **Illustrative layout sketch** for each floor, with numbered blocks, the plot dimensions as entered and "Illustrative layout only — not CAD or a construction drawing".
- **Say:**
  - "The layout sketch is drawn by our own code from the customer's answers, not by an AI model, so it's deterministic. It shows the plot in the customer's proportions and one block per requested room; block sizes are a drawing rule, not room sizes."
  - "The pictures come from a test generator. No AI image model is connected yet. They're static images, not a 3D model."
- **Status:** Images are mock-only. The sketch was browser-verified on 2026-10-21 (two floors, labelled "Illustrative layout only — not CAD or a construction drawing"). Labels inside the blocks are small at normal width; narrow blocks show only a number, and the numbered list beside the sketch carries the names.
- **Fallback:** If the sketch does not render, say so and show the offline test evidence (`tests/unit/floor-plan.test.ts`) instead.

### 4. Interior or landscape — 2:10 to 2:45 (35 s)

- **Do:** Open `/new/interior` and show the form, including the notice **"Uploads not configured yet"**. Then open `/projects/[B]/results`.
- **Say:** "The original plan has the customer upload a room or garden photo here. Uploads aren't built yet: the allowed file types, sizes and how long photos are kept are open decisions. The concept you see uses the same release rules, and it's a mock."
- **Status:** **Not available.** The spec's "upload safe sample image" cannot be shown, and this is a labelled fallback. Images are mock-only.

### 5. Pricing and payment — 2:45 to 3:40 (55 s)

- **Do:** On `/projects/[C]/quote`, show the itemized quote with the **"Demo rates"** label and click **Accept this quote**. On `/projects/[C]/payment`, show the demo payment instructions, enter a test reference, date and amount, and click **Submit payment details for review**.
- **You see:**
  - itemized lines, tax and total, labelled "Demo rates";
  - after submitting, the status "Payment evidence submitted": pending, never verified automatically.
- **Say:** "Prices are calculated on the server and frozen when accepted. These are demonstration rates. The customer only submits evidence; nothing is treated as paid until an administrator checks the receiving account."
- **Optional (10 s, admin profile):** Show `/admin/pricing`: "Administrators publish new versions of rates for new quotes; accepted quotes don't change. Switching from demo to real rates is a separate owner decision." The pricing screen **needs a browser check**.
- **Status:** Verified (earlier, local), with demo values.

### 6. Admin verification and release — 3:40 to 4:35 (55 s)

- **Do (admin profile):** On `/admin/payments`, open project D's payment. Show the 60-second proof link, type the full quoted amount, tick the confirmation and click **Verify payment**.
- **You see:** The payment is verified and the decision is recorded in the audit trail.
- **Do:** On `/admin/generation/[D]`, click **Start mock generation**.
  - **You see:** Placeholder images and the layout sketch, private, with the MOCK warning.
  - **Then:** Tick the review and mock acknowledgements and click the release button, which reads **Release N image(s) to the customer** ("Release to the customer" is the heading above it).
- **If time is short:** Show project A's admin page (already released) instead of generating live.
- **Do (customer profile):** Open `/projects/[D]/results`.
- **Say:** "Generation can only start after verified payment. That's enforced in the database, not just hidden in the interface. Nothing reaches the customer until an administrator releases it."
- **Status:**
  - payment verification: verified (earlier, local);
  - generation start and release: browser-verified on 2026-10-21 for all three journeys (mock images), after earlier local live-suite evidence.
- **Fallback:** If any action misbehaves, stop and show project A instead. Never force or fake a state.

### 7. Security and limits — 4:35 to 5:00 (25 s)

- **Do:** Open `/admin/generation/[C]`, a project not yet verified.
- **You see:** "Not ready. Generation can start only after an administrator has verified the payment." There is no start button.
- **Do (optional, terminal):** Run the offline proof. It runs in-process with no services and no network:

  ```bash
  npx vitest run tests/unit/generation-service.test.ts tests/db/workflow-guards.test.ts
  ```

  Point to the tests "refuses when the database says the payment is not verified (client status is irrelevant)" and "cannot create a generation job without a verified payment, whatever the project status".
- **Say:** "Even a direct request can't generate for an unpaid project. And to be clear: these are concepts, not CAD or construction drawings."
- **Status:** The screen was browser-verified on 2026-10-21. The tests are verified offline (current code, 2026-10-21). The spec's "denied unpaid-generation **API** test" is shown through these tests, not a live HTTP call: generation is a Server Action, not a public REST route.

## What this demo does not show

- Live Gnani speech-to-text or text-to-speech.
- A live OpenRouter brief, or real AI images.
- Reference uploads.
- Real payments or real prices.
- A hosted URL.
- Mobile-width behaviour (not yet checked).

Say so if asked. These are listed under "Known limitations" in the README.
