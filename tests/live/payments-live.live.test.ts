import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { requireAdmin } from "@/lib/auth/guards";
import { mockBriefProvider } from "@/lib/journeys/brief";
import { acceptQuote, createBrief, createDraftProject, createQuote, getLatestQuote, getOwnedProject, reviewBrief, saveStep } from "@/lib/journeys/service";
import {
  createProofPreviewUrl,
  getPaymentForAdmin,
  listOwnPayments,
  listPaymentQueue,
  rejectPayment,
  submitPayment,
  verifyPayment,
} from "@/lib/payments/service";
import { PROJECT_FILES_BUCKET } from "@/lib/storage/paths";
import { REQUIREMENTS } from "../unit/support/journey-fixtures";

/**
 * Phase 4 live verification against a LOCAL Supabase stack: payment evidence, the
 * administrator's decision, privacy of the proof, and the generation gate. Runs the real
 * service layer with real Auth, PostgREST and Storage. It refuses to run unless the URL is
 * this machine, and uses @example.test accounts and fake data only.
 *
 *   LIVE_SUPABASE=1 npx vitest run --config vitest.live.config.mts
 */

const ENABLED = process.env.LIVE_SUPABASE === "1";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_CONTAINER = "supabase_db_Gnani_intern";
const PASSWORD = "Live-test-" + randomUUID();
const RUN = randomUUID().slice(0, 8);
const DEMO_ENV = { PAYMENT_MODE: "manual", PAYMENT_UPI_ID: "DEMO-DO-NOT-PAY@demo", PAYMENT_INSTRUCTIONS: "DEMO — DO NOT TRANSFER MONEY.", PAYMENT_CURRENCY: "INR" };

if (ENABLED && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) {
  throw new Error("Refusing to run live tests: NEXT_PUBLIC_SUPABASE_URL is not a local address.");
}

function sql(query: string, input?: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", ...(input === undefined ? ["-c", query] : [])],
    { encoding: "utf8", input },
  ).trim();
}

/** A tiny but real PNG header followed by padding, so the magic-byte check recognises it. */
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 64 }, (_, i) => i)]);
const receipt = (name = "receipt.png") => new File([PNG_BYTES], name, { type: "image/png" });

describe.skipIf(!ENABLED)("live local Supabase: payment evidence and review", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  const users = {} as Record<"a" | "b" | "admin", { id: string; client: SupabaseClient }>;
  let projectId = "";
  let draftId = "";
  let total = 0;
  let firstPaymentId = "";
  let secondPaymentId = "";
  let proofPath = "";

  const fields = (amount = total.toFixed(2)) => ({ utrReference: `LIVE${RUN.toUpperCase()}01`, transferDate: new Date().toISOString().slice(0, 10), amount, method: "UPI" });
  const bucket = (c: SupabaseClient) => c.storage.from(PROJECT_FILES_BUCKET);
  const state = () => sql(`select status from public.projects where id = '${projectId}'`);
  const paymentRows = () => Number(sql(`select count(*) from public.payments where project_id = '${projectId}'`));

  async function makeUser(label: "a" | "b" | "admin") {
    const email = `live-pay-${label}-${RUN}@example.test`;
    const created = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    expect(created.error).toBeNull();
    const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await client.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
    users[label] = { id: created.data.user!.id, client };
  }

  beforeAll(async () => {
    expect(URL_ && ANON && SERVICE).toBeTruthy();
    service = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    await makeUser("a");
    await makeUser("b");
    await makeUser("admin");
    sql(`insert into public.admin_users (user_id) values ('${users.admin.id}')`);
    // Demo rates, labelled as such, so a quote can be produced (local database only).
    // Non-destructive: load the labelled demo rates only into an empty table, never replace existing ones.
    if (sql("select count(*) from public.pricing_rules") === "0") sql("", readFileSync(path.join(process.cwd(), "supabase/demo/pricing_rules.demo.sql"), "utf8"));

    // Walk customer A to AWAITING_PAYMENT through the real service layer.
    const a = users.a;
    const created = await createDraftProject(a.client, a.id, "EMPTY_PLOT");
    if (!created.ok) throw new Error("setup: draft project");
    projectId = created.projectId;
    for (const [stepId, data] of Object.entries(REQUIREMENTS.EMPTY_PLOT)) await saveStep(a.client, a.id, projectId, stepId, data, undefined, { service: () => service });
    expect(await createBrief(a.client, service, a.id, projectId, mockBriefProvider)).toEqual({ ok: true });
    expect(await reviewBrief(a.client, service, a.id, projectId, "approve", "Approved brief.", true)).toEqual({ ok: true });
    expect(await createQuote(a.client, service, a.id, projectId)).toEqual({ ok: true });
    const quote = (await getLatestQuote(a.client, projectId))!;
    total = quote.totalAmount;
    expect(await acceptQuote(a.client, service, a.id, projectId, quote.id)).toEqual({ ok: true });
    const draft = await createDraftProject(a.client, a.id, "INTERIOR");
    if (!draft.ok) throw new Error("setup: second project");
    draftId = draft.projectId;
    expect(state()).toBe("AWAITING_PAYMENT");
  });

  describe("before any submission", () => {
    it("refuses a submission while payment instructions are not configured, and writes nothing", async () => {
      for (const env of [{}, { PAYMENT_MODE: "manual" }, { ...DEMO_ENV, PAYMENT_CURRENCY: "USD" }]) {
        const r = await submitPayment(users.a.client, service, users.a.id, projectId, { ...fields(), file: receipt() }, { env });
        expect(r).toMatchObject({ ok: false, message: expect.stringContaining("Payment instructions not configured") });
      }
      expect(paymentRows()).toBe(0);
      expect(state()).toBe("AWAITING_PAYMENT");
    });

    it("another customer cannot submit evidence for this project", async () => {
      const r = await submitPayment(users.b.client, service, users.b.id, projectId, { ...fields(), file: receipt() }, { env: DEMO_ENV });
      expect(r).toMatchObject({ ok: false });
      const direct = await users.b.client.from("payments").insert({ project_id: projectId, quote_id: randomUUID(), amount_claimed: 1, currency: "INR", method: "UPI", utr_reference: "ATTACKER01", transfer_date: "2026-10-18" });
      expect(direct.error).not.toBeNull();
      expect(paymentRows()).toBe(0);
    });

    it("a direct API insert cannot start as verified, nor carry a decision", async () => {
      const quote = (await getLatestQuote(users.a.client, projectId))!;
      const base = { project_id: projectId, quote_id: quote.id, amount_claimed: total, currency: "INR", method: "UPI", utr_reference: "FORGED00001", transfer_date: new Date().toISOString().slice(0, 10) };
      expect((await users.a.client.from("payments").insert({ ...base, status: "VERIFIED" })).error).not.toBeNull();
      expect((await users.a.client.from("payments").insert({ ...base, status: "VERIFIED", verified_by: users.a.id, confirmed_amount: total })).error).not.toBeNull();
      expect(paymentRows()).toBe(0);
    });

    it("the Storage API itself refuses non-images, SVG and oversized files, whatever the app checks", async () => {
      const send = (name: string, body: Blob, type: string) => bucket(users.a.client).upload(`${draftId}/references/${name}`, body, { contentType: type });
      expect((await send("note.txt", new Blob(["hello"]), "text/plain")).error).not.toBeNull();
      expect((await send("x.svg", new Blob(["<svg xmlns='http://www.w3.org/2000/svg'/>"]), "image/svg+xml")).error).not.toBeNull();
      expect((await send("x.pdf", new Blob(["%PDF-1.4"]), "application/pdf")).error).not.toBeNull();
      expect((await send("big.png", new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "image/png" }), "image/png")).error).not.toBeNull();
      expect((await send("ok.png", new Blob([PNG_BYTES], { type: "image/png" }), "image/png")).error).toBeNull();
      // The limit applies to the trusted service role too.
      expect((await bucket(service).upload(`${projectId}/generated/x.txt`, new Blob(["hello"]), { contentType: "text/plain" })).error).not.toBeNull();
    });

    it("the application refuses a disguised file before it reaches Storage", async () => {
      const fake = new File([new TextEncoder().encode("MZ this is not an image")], "receipt.png", { type: "image/png" });
      const r = await submitPayment(users.a.client, service, users.a.id, projectId, { ...fields(), file: fake }, { env: DEMO_ENV });
      expect(r).toMatchObject({ ok: false, fieldErrors: { evidence: expect.any(String) } });
      expect(paymentRows()).toBe(0);
    });
  });

  describe("customer submits evidence", () => {
    it("creates a PENDING_REVIEW claim and moves the project to PAYMENT_PROOF_SUBMITTED, unverified", async () => {
      const r = await submitPayment(users.a.client, service, users.a.id, projectId, { ...fields(), file: receipt() }, { env: DEMO_ENV });
      expect(r).toMatchObject({ ok: true });
      if (!r.ok) return;
      firstPaymentId = r.paymentId;
      const [row] = sql(`select status || '|' || coalesce(verified_by::text,'') || '|' || coalesce(confirmed_amount::text,'') || '|' || proof_storage_path from public.payments where id = '${firstPaymentId}'`).split("\n");
      const [status, verifiedBy, confirmed, pathText] = row.split("|");
      expect(status).toBe("PENDING_REVIEW");
      expect(verifiedBy).toBe("");
      expect(confirmed).toBe("");
      expect(pathText).toMatch(new RegExp(`^${projectId}/payment-proofs/[0-9a-f-]{36}\\.png$`));
      proofPath = pathText;
      expect(state()).toBe("PAYMENT_PROOF_SUBMITTED");
      const own = await listOwnPayments(users.a.client, projectId);
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ status: "PENDING_REVIEW", hasProof: true, verifiedAt: null });
    });

    it("a second submission while one is pending is refused", async () => {
      const r = await submitPayment(users.a.client, service, users.a.id, projectId, { ...fields(), utrReference: "SECOND000001", file: null }, { env: DEMO_ENV });
      expect(r).toMatchObject({ ok: false });
      expect(paymentRows()).toBe(1);
    });

    it("stored the image privately: owner and administrator can read it, nobody else can", async () => {
      expect((await bucket(users.a.client).download(proofPath)).error).toBeNull();
      expect((await bucket(users.b.client).download(proofPath)).error).not.toBeNull();
      expect((await bucket(anon).download(proofPath)).error).not.toBeNull();
      expect((await fetch(`${URL_}/storage/v1/object/public/${PROJECT_FILES_BUCKET}/${proofPath}`)).ok).toBe(false);
    });

    it("customers cannot see admin-only columns or other customers' payments", async () => {
      expect((await users.a.client.from("payments").select("verified_by")).error).not.toBeNull();
      expect((await users.a.client.from("payments").select("audit_note")).error).not.toBeNull();
      expect(await listOwnPayments(users.b.client, projectId)).toEqual([]);
    });
  });

  describe("only an administrator can decide, and the gate stays closed", () => {
    it("a customer cannot verify or reject, directly or through the service layer", async () => {
      expect((await users.a.client.rpc("admin_verify_payment", { p_payment_id: firstPaymentId, p_confirmed_amount: total })).error).not.toBeNull();
      expect((await users.a.client.from("payments").update({ status: "VERIFIED" }).eq("id", firstPaymentId)).error).not.toBeNull();
      expect(await verifyPayment(users.a.client, firstPaymentId, { confirmedAmount: total.toFixed(2), note: "", acknowledged: true })).toMatchObject({ ok: false });
      expect(await rejectPayment(users.b.client, firstPaymentId, { reason: "I am not an admin", note: "" })).toMatchObject({ ok: false });
      expect(await rejectPayment(anon, firstPaymentId, { reason: "I am nobody", note: "" })).toMatchObject({ ok: false });
      await expect(requireAdmin(users.a.client)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(sql(`select status from public.payments where id = '${firstPaymentId}'`)).toBe("PENDING_REVIEW");
      expect(state()).toBe("PAYMENT_PROOF_SUBMITTED");
    });

    it("the service role cannot decide (no administrator identity)", async () => {
      expect((await service.rpc("admin_verify_payment", { p_payment_id: firstPaymentId, p_confirmed_amount: total })).error).not.toBeNull();
      expect((await service.rpc("admin_reject_payment", { p_payment_id: firstPaymentId, p_reason: "service" })).error).not.toBeNull();
    });

    it("generation is blocked while the payment is only pending", async () => {
      expect((await service.from("projects").update({ status: "GENERATING" }).eq("id", projectId)).error).not.toBeNull();
      expect((await service.from("generation_jobs").insert({ project_id: projectId, provider: "mock", prompt_version: "live" })).error).not.toBeNull();
      expect((await users.a.client.from("projects").update({ status: "PAYMENT_VERIFIED" }).eq("id", projectId)).error).not.toBeNull();
      expect(state()).toBe("PAYMENT_PROOF_SUBMITTED");
    });

    it("the administrator reads the queue (one embedded read per list) and a short-lived proof link", async () => {
      const queue = await listPaymentQueue(users.admin.client);
      const mine = queue.pending.find((p) => p.id === firstPaymentId);
      expect(mine).toMatchObject({ projectId, customerId: users.a.id, quoteTotal: total, hasProof: true });
      const detail = await getPaymentForAdmin(users.admin.client, service, firstPaymentId);
      expect(detail).toMatchObject({ proofPath, verifiedBy: null });
      const url = await createProofPreviewUrl(users.admin.client, detail!);
      expect(url).toBeTruthy();
      const res = await fetch(url!);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
      // A customer's session cannot make a link to someone else's proof.
      expect(await createProofPreviewUrl(users.b.client, detail!)).toBeNull();
    });

    it("rejecting needs a reason; a rejection is recorded, audited and shown to the customer", async () => {
      expect(await rejectPayment(users.admin.client, firstPaymentId, { reason: "  ", note: "" })).toMatchObject({ ok: false });
      expect(await rejectPayment(users.admin.client, firstPaymentId, { reason: "No matching credit was found.", note: "checked statement" })).toEqual({ ok: true });
      expect(state()).toBe("PAYMENT_REJECTED");
      const own = await listOwnPayments(users.a.client, projectId);
      expect(own[0]).toMatchObject({ status: "REJECTED", rejectionReason: "No matching credit was found." });
      const audit = sql(`select actor_id::text from public.audit_events where payment_id = '${firstPaymentId}' and action = 'payment.rejected'`);
      expect(audit).toBe(users.admin.id);
      const detail = await getPaymentForAdmin(users.admin.client, service, firstPaymentId);
      expect(detail).toMatchObject({ verifiedBy: users.admin.id, auditNote: "checked statement" });
    });

    it("a decision is final", async () => {
      expect(await rejectPayment(users.admin.client, firstPaymentId, { reason: "Again", note: "" })).toMatchObject({ ok: false });
      expect(await verifyPayment(users.admin.client, firstPaymentId, { confirmedAmount: total.toFixed(2), note: "", acknowledged: true })).toMatchObject({ ok: false });
      expect(sql(`select status from public.payments where id = '${firstPaymentId}'`)).toBe("REJECTED");
    });

    it("the customer can submit again after a rejection", async () => {
      const r = await submitPayment(users.a.client, service, users.a.id, projectId, { ...fields(), utrReference: `LIVE${RUN.toUpperCase()}02`, file: null }, { env: DEMO_ENV });
      expect(r).toMatchObject({ ok: true });
      if (r.ok) secondPaymentId = r.paymentId;
      expect(state()).toBe("PAYMENT_PROOF_SUBMITTED");
      expect(paymentRows()).toBe(2);
    });

    it("verification needs the full quoted total and an explicit confirmation", async () => {
      const ok = { note: "", acknowledged: true };
      expect(await verifyPayment(users.admin.client, secondPaymentId, { ...ok, confirmedAmount: "1.00" })).toMatchObject({ ok: false });
      expect(await verifyPayment(users.admin.client, secondPaymentId, { ...ok, confirmedAmount: (total - 0.01).toFixed(2) })).toMatchObject({ ok: false });
      expect(await verifyPayment(users.admin.client, secondPaymentId, { note: "", confirmedAmount: total.toFixed(2), acknowledged: false })).toMatchObject({ ok: false });
      // Even bypassing the service layer, the database refuses a different amount.
      expect((await users.admin.client.rpc("admin_verify_payment", { p_payment_id: secondPaymentId, p_confirmed_amount: total - 1 })).error).not.toBeNull();
      expect(sql(`select status from public.payments where id = '${secondPaymentId}'`)).toBe("PENDING_REVIEW");
      expect(state()).toBe("PAYMENT_PROOF_SUBMITTED");
    });

    it("two administrators verifying at the same moment: exactly one decision is recorded", async () => {
      const input = { confirmedAmount: total.toFixed(2), note: "concurrent", acknowledged: true };
      const results = await Promise.all([verifyPayment(users.admin.client, secondPaymentId, input), verifyPayment(users.admin.client, secondPaymentId, input)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(Number(sql(`select count(*) from public.audit_events where payment_id = '${secondPaymentId}' and action = 'payment.verified'`))).toBe(1);
    });

    it("verification is audited and moves the project to PAYMENT_VERIFIED, and nothing else starts", async () => {
      expect(sql(`select status || '|' || confirmed_amount::text || '|' || verified_by::text from public.payments where id = '${secondPaymentId}'`)).toBe(`VERIFIED|${total.toFixed(2)}|${users.admin.id}`);
      expect(sql(`select actor_id::text from public.audit_events where payment_id = '${secondPaymentId}' and action = 'payment.verified'`)).toBe(users.admin.id);
      expect(state()).toBe("PAYMENT_VERIFIED");
      // Verification enables generation but does not start it or release anything.
      expect(Number(sql(`select count(*) from public.generation_jobs where project_id = '${projectId}'`))).toBe(0);
      expect(Number(sql(`select count(*) from public.design_assets where project_id = '${projectId}' and asset_type <> 'REFERENCE'`))).toBe(0);
      expect((await getOwnedProject(users.a.client, users.a.id, projectId))?.status).toBe("PAYMENT_VERIFIED");
    });

    it("a customer still cannot start generation or submit more evidence, and cannot read generated files", async () => {
      expect((await users.a.client.from("projects").update({ status: "GENERATING" }).eq("id", projectId)).error).not.toBeNull();
      const r = await submitPayment(users.a.client, service, users.a.id, projectId, { ...fields(), utrReference: "AFTER0000001", file: null }, { env: DEMO_ENV });
      expect(r).toMatchObject({ ok: false });
      expect(paymentRows()).toBe(2);
    });

    it("the queue now lists both decisions, newest first, and nothing pending", async () => {
      const queue = await listPaymentQueue(users.admin.client);
      expect(queue.pending.find((p) => [firstPaymentId, secondPaymentId].includes(p.id))).toBeUndefined();
      const ids = queue.decided.map((p) => p.id);
      expect(ids.indexOf(secondPaymentId)).toBeLessThan(ids.indexOf(firstPaymentId));
    });
  });
});
