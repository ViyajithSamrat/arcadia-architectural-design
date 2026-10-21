import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { requireAdmin, requireUser } from "@/lib/auth/guards";
import { AuthError } from "@/lib/auth/errors";
import { PAYMENT_CUSTOMER_COLUMNS } from "@/lib/db/schema";
import { mockBriefProvider } from "@/lib/journeys/brief";
import { acceptQuote, createBrief, createDraftProject, createQuote, getLatestQuote, getOwnedProject, previewQuote, reviewBrief, saveStep } from "@/lib/journeys/service";
import { REQUIREMENTS } from "../unit/support/journey-fixtures";

/**
 * Live verification against a LOCAL Supabase stack. Nothing is skipped silently:
 * without LIVE_SUPABASE=1 the whole file is skipped, and with it the suite throws
 * unless the URL points at this machine. It never touches a hosted project.
 *
 * Tests run in order and share state (users, projects). Test accounts use
 * @example.test addresses and fake data; nothing here is a real customer or payment.
 */

const ENABLED = process.env.LIVE_SUPABASE === "1";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DB_CONTAINER = "supabase_db_Gnani_intern";
const PASSWORD = "Live-test-" + randomUUID();
const RUN = randomUUID().slice(0, 8);

if (ENABLED && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) {
  throw new Error("Refusing to run live tests: NEXT_PUBLIC_SUPABASE_URL is not a local address.");
}

/** Runs SQL as the database owner inside the local Postgres container. */
function sql(query: string, input?: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", ...(input === undefined ? ["-c", query] : [])],
    { encoding: "utf8", input },
  ).trim();
}

const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });

describe.skipIf(!ENABLED)("live local Supabase", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  const users = {} as Record<"a" | "b" | "admin", { id: string; client: SupabaseClient }>;
  let projectA = ""; // walks the whole journey
  let projectD = ""; // stays a draft, used for storage
  let quoteId = "";
  let paymentId = "";

  async function makeUser(label: "a" | "b" | "admin") {
    const email = `live-${label}-${RUN}@example.test`;
    const created = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    expect(created.error).toBeNull();
    const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await client.auth.signInWithPassword({ email, password: PASSWORD });
    expect(signed.error).toBeNull();
    users[label] = { id: created.data.user!.id, client };
  }

  beforeAll(() => {
    expect(URL_ && ANON && SERVICE).toBeTruthy();
    service = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    // Re-runnable: earlier runs leave demo pricing behind, and "Pricing not configured" needs none.
    // Only configuration rows are cleared; users, projects and audit history are left alone.
    sql("delete from public.pricing_rules; delete from public.site_settings where key = 'pricing_mode'");
  });

  // ------------------------------------------------------------ 2. schema
  describe("migrations and schema", () => {
    it("applied every migration in filename order", () => {
      const files = readdirSync(path.join(process.cwd(), "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
      const applied = sql("select version from supabase_migrations.schema_migrations order by version").split("\n");
      expect(applied).toEqual(files.map((f) => f.split("_")[0]));
    });

    it("created the eleven tables with RLS enabled on every one", () => {
      const rows = sql(
        "select relname || ':' || relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by relname",
      ).split("\n");
      expect(rows).toHaveLength(11);
      expect(rows.every((r) => r.endsWith(":true"))).toBe(true);
    });

    it("created a private project-files bucket", () => {
      expect(sql("select public from storage.buckets where id = 'project-files'")).toBe("f");
    });

    it("seeded the 24 allowed status transitions and no prices", () => {
      expect(sql("select count(*) from public.project_status_transitions")).toBe("24");
      expect(sql("select count(*) from public.pricing_rules")).toBe("0");
    });

    it("exposes only public (and graphql_public) through the API; app_private is not reachable", async () => {
      const res = await fetch(`${URL_}/rest/v1/audit_events?select=id`, { headers: { apikey: ANON, "Accept-Profile": "app_private" } });
      expect(res.ok).toBe(false);
    });
  });

  // ------------------------------------------------------------ 3-4. auth
  describe("authentication", () => {
    it("creates two customers and one administrator and signs them in", async () => {
      await makeUser("a");
      await makeUser("b");
      await makeUser("admin");
      sql(`insert into public.admin_users (user_id) values ('${users.admin.id}')`);
    });

    it("requireUser accepts a real session and rejects an anonymous client", async () => {
      expect((await requireUser(users.a.client)).id).toBe(users.a.id);
      await expect(requireUser(anon)).rejects.toBeInstanceOf(AuthError);
    });

    it("requireAdmin: administrator passes, customer is forbidden", async () => {
      expect((await requireAdmin(users.admin.client)).id).toBe(users.admin.id);
      await expect(requireAdmin(users.a.client)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a session survives a new client built from the same tokens, and sign-out ends it", async () => {
      const { data } = await users.b.client.auth.getSession();
      const again = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
      await again.auth.setSession({ access_token: data.session!.access_token, refresh_token: data.session!.refresh_token });
      expect((await again.auth.getUser()).data.user?.id).toBe(users.b.id);
      await again.auth.signOut();
      expect((await again.auth.getUser()).data.user).toBeNull();
      // Keep B usable for later steps.
      const relogin = await users.b.client.auth.signInWithPassword({ email: `live-b-${RUN}@example.test`, password: PASSWORD });
      expect(relogin.error).toBeNull();
    });

    it("the anonymous role cannot read any application table", async () => {
      for (const table of ["projects", "quotes", "payments", "design_assets", "audit_events", "pricing_rules", "site_settings", "generation_jobs", "admin_users"]) {
        const res = await anon.from(table).select("*").limit(1);
        expect(res.error, table).not.toBeNull();
      }
    });
  });

  // ------------------------------------------------------------ 5-7. journey
  describe("customer journey through the real service layer", () => {
    it("customer A creates a draft project they own", async () => {
      const created = await createDraftProject(users.a.client, users.a.id, "EMPTY_PLOT");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      projectA = created.projectId;
      const row = await getOwnedProject(users.a.client, users.a.id, projectA);
      expect(row).toMatchObject({ customer_id: users.a.id, status: "DRAFT", project_type: "EMPTY_PLOT" });
      const second = await createDraftProject(users.a.client, users.a.id, "INTERIOR");
      if (second.ok) projectD = second.projectId;
      expect(projectD).toBeTruthy();
    });

    it("customer B cannot see, edit or advance A's project", async () => {
      expect(await getOwnedProject(users.b.client, users.b.id, projectA)).toBeNull();
      expect((await users.b.client.from("projects").select("id").eq("id", projectA)).data).toEqual([]);
      const patch = await users.b.client.from("projects").update({ requirements_json: { hacked: true } }).eq("id", projectA).select("id");
      expect(patch.data ?? []).toEqual([]);
      expect(await saveStep(users.b.client, users.b.id, projectA, "space", REQUIREMENTS.EMPTY_PLOT.space)).toMatchObject({ ok: false });
      expect(await createBrief(users.b.client, service, users.b.id, projectA, mockBriefProvider)).toMatchObject({ ok: false });
      expect(await createQuote(users.b.client, service, users.b.id, projectA)).toMatchObject({ ok: false });
    });

    it("B cannot create a project that claims to belong to A", async () => {
      const res = await users.b.client.from("projects").insert({ customer_id: users.a.id, project_type: "EMPTY_PLOT" });
      expect(res.error).not.toBeNull();
    });

    it("A saves every step, then creates the brief (DRAFT -> BRIEF_REVIEW)", async () => {
      for (const [stepId, data] of Object.entries(REQUIREMENTS.EMPTY_PLOT)) {
        const saved = await saveStep(users.a.client, users.a.id, projectA, stepId, data, undefined, { service: () => service });
        expect(saved, stepId).toMatchObject({ ok: true });
      }
      expect(await createBrief(users.a.client, service, users.a.id, projectA, mockBriefProvider)).toEqual({ ok: true });
      const row = await getOwnedProject(users.a.client, users.a.id, projectA);
      expect(row?.status).toBe("BRIEF_REVIEW");
      expect(row?.english_brief_text).toContain("30 × 40 ft");
    });

    it("changing an answer clears the brief; creating it again restores it", async () => {
      await saveStep(users.a.client, users.a.id, projectA, "description", { text: "Changed my mind" }, undefined, { service: () => service });
      expect((await getOwnedProject(users.a.client, users.a.id, projectA))?.english_brief_json).toBeNull();
      expect(await createBrief(users.a.client, service, users.a.id, projectA, mockBriefProvider)).toEqual({ ok: true });
    });

    it("A cannot change status, owner or type directly through the API", async () => {
      const attempts = [{ status: "BRIEF_APPROVED" }, { status: "RELEASED" }, { project_type: "LANDSCAPE" }, { customer_id: users.b.id }, { approved_at: new Date().toISOString() }];
      for (const patch of attempts) {
        const res = await users.a.client.from("projects").update(patch).eq("id", projectA).select("id");
        expect(res.error, JSON.stringify(patch)).not.toBeNull();
      }
      expect((await getOwnedProject(users.a.client, users.a.id, projectA))?.status).toBe("BRIEF_REVIEW");
    });

    it("A cannot write the transcript or language columns directly through the API (R1-C)", async () => {
      // The project is still editable (BRIEF_REVIEW), so only the R1-C restriction can refuse these.
      const attempts = [{ transcript_original: "typed but claimed as speech" }, { transcript_corrected: "edited" }, { source_language: "ta-IN" }];
      for (const patch of attempts) {
        const res = await users.a.client.from("projects").update(patch).eq("id", projectA).select("id");
        expect(res.error, JSON.stringify(patch)).not.toBeNull();
      }
      const insert = await users.a.client.from("projects").insert({ customer_id: users.a.id, project_type: "INTERIOR", transcript_original: "fake" });
      expect(insert.error).not.toBeNull();
      const row = await getOwnedProject(users.a.client, users.a.id, projectA);
      expect(row?.transcript_original ?? null).toBeNull();
      expect(row?.source_language).toBe("en");
    });

    it("approval is refused without confirmation, and works with it (BRIEF_REVIEW -> BRIEF_APPROVED)", async () => {
      expect(await reviewBrief(users.a.client, service, users.a.id, projectA, "approve", "Edited brief text.", false)).toMatchObject({ ok: false });
      expect(await reviewBrief(users.a.client, service, users.a.id, projectA, "approve", "Edited brief text.", true)).toEqual({ ok: true });
      const row = await getOwnedProject(users.a.client, users.a.id, projectA);
      expect(row?.status).toBe("BRIEF_APPROVED");
      expect(row?.approved_at).toBeTruthy();
      expect(row?.english_brief_text).toBe("Edited brief text.");
    });

    it("the approved brief can no longer be edited by the customer", async () => {
      const res = await users.a.client.from("projects").update({ english_brief_text: "sneaky" }).eq("id", projectA).select("id");
      expect(res.data ?? []).toEqual([]);
    });

    it("with no pricing configured the quote is refused and nothing is created", async () => {
      const project = (await getOwnedProject(users.a.client, users.a.id, projectA))!;
      expect(await previewQuote(service, project)).toMatchObject({ configured: false, reason: "no_rules" });
      expect(await createQuote(users.a.client, service, users.a.id, projectA)).toMatchObject({ ok: false, message: expect.stringMatching(/Pricing not configured/) });
      expect(sql(`select count(*) from public.quotes where project_id = '${projectA}'`)).toBe("0");
      expect((await getOwnedProject(users.a.client, users.a.id, projectA))?.status).toBe("BRIEF_APPROVED");
    });

    it("customers cannot read pricing rules or settings, nor create quotes themselves", async () => {
      // RLS is admin-only, so a customer gets an empty result rather than an error.
      expect((await users.a.client.from("pricing_rules").select("*")).data).toEqual([]);
      expect((await users.a.client.from("site_settings").select("*")).data).toEqual([]);
      expect((await users.a.client.from("pricing_rules").insert({ project_type: "EMPTY_PLOT", rule_key: "base_fee", rate: 0, unit: "x", currency: "INR", version: 99 })).error).not.toBeNull();
      const forged = await users.a.client.from("quotes").insert({ project_id: projectA, currency: "INR", line_items_json: [], subtotal: 1, total_amount: 1, pricing_rule_version: "x" });
      expect(forged.error).not.toBeNull();
    });

    it("demo pricing loads, and the server then builds a demo-labelled quote (BRIEF_APPROVED -> QUOTED)", async () => {
      sql("", readFileSync(path.join(process.cwd(), "supabase/demo/pricing_rules.demo.sql"), "utf8"));
      expect(sql("select count(*) from public.pricing_rules")).toBe("17");
      // Customers still see none of it; an administrator sees all of it.
      expect((await users.a.client.from("pricing_rules").select("id")).data).toEqual([]);
      expect((await users.admin.client.from("pricing_rules").select("id")).data).toHaveLength(17);
      expect(await createQuote(users.a.client, service, users.a.id, projectA)).toEqual({ ok: true });
      const quote = await getLatestQuote(users.a.client, projectA);
      expect(quote).not.toBeNull();
      quoteId = quote!.id;
      expect(quote!.pricingRuleVersion.startsWith("DEMO:")).toBe(true);
      expect(quote!.currency).toBe("INR");
      expect(quote!.totalAmount).toBeCloseTo(quote!.subtotal + quote!.taxAmount - quote!.discountAmount, 2);
      expect((await getOwnedProject(users.a.client, users.a.id, projectA))?.status).toBe("QUOTED");
    });

    it("the quote is visible to A only", async () => {
      expect(await getLatestQuote(users.b.client, projectA)).toBeNull();
      expect((await users.b.client.from("quotes").select("id")).data).toEqual([]);
    });

    it("B cannot accept A's quote; A accepts it (QUOTED -> AWAITING_PAYMENT) and cannot accept twice", async () => {
      expect(await acceptQuote(users.b.client, service, users.b.id, projectA, quoteId)).toMatchObject({ ok: false });
      expect(await acceptQuote(users.a.client, service, users.a.id, projectA, quoteId)).toEqual({ ok: true });
      expect((await getOwnedProject(users.a.client, users.a.id, projectA))?.status).toBe("AWAITING_PAYMENT");
      expect(await acceptQuote(users.a.client, service, users.a.id, projectA, quoteId)).toMatchObject({ ok: false });
    });

    it("an accepted quote is frozen even against the service role", async () => {
      const res = await service.from("quotes").update({ total_amount: 1, subtotal: 1 }).eq("id", quoteId);
      expect(res.error).not.toBeNull();
    });
  });

  // ------------------------------------------------------------ 8. forbidden transitions
  describe("forbidden workflow moves (trusted client included)", () => {
    const move = (status: string, id = () => projectA) => service.from("projects").update({ status }).eq("id", id()).select("id");

    it("cannot jump to generation, payment states, release or back to draft", async () => {
      for (const status of ["GENERATING", "PAYMENT_VERIFIED", "PAYMENT_PROOF_SUBMITTED", "READY_FOR_REVIEW", "RELEASED", "DRAFT", "QUOTED"]) {
        expect((await move(status)).error, status).not.toBeNull();
      }
      expect(sql(`select status from public.projects where id = '${projectA}'`)).toBe("AWAITING_PAYMENT");
    });

    it("cannot skip steps on a draft project either", async () => {
      for (const status of ["QUOTED", "AWAITING_PAYMENT", "BRIEF_APPROVED", "RELEASED"]) {
        expect((await move(status, () => projectD)).error, status).not.toBeNull();
      }
    });

    it("no generation job without a verified payment, even for the service role", async () => {
      const res = await service.from("generation_jobs").insert({ project_id: projectA, provider: "mock", prompt_version: "live-test" });
      expect(res.error).not.toBeNull();
    });

    it("the service role cannot verify a payment (no administrator identity)", async () => {
      const res = await service.rpc("admin_verify_payment", { p_payment_id: randomUUID(), p_confirmed_amount: 1 });
      expect(res.error).not.toBeNull();
    });
  });

  // ------------------------------------------------------------ 9. storage
  describe("private storage", () => {
    const bucket = (c: SupabaseClient) => c.storage.from("project-files");

    it("A uploads a reference to their own editable project", async () => {
      const res = await bucket(users.a.client).upload(`${projectD}/references/room.png`, png(), { contentType: "image/png" });
      expect(res.error).toBeNull();
    });

    it("A can read it back through a short-lived signed URL; the plain URL is not public", async () => {
      const signed = await bucket(users.a.client).createSignedUrl(`${projectD}/references/room.png`, 60);
      expect(signed.error).toBeNull();
      const body = await fetch(signed.data!.signedUrl);
      expect(body.status).toBe(200);
      expect((await body.arrayBuffer()).byteLength).toBe(8);
      const plain = await fetch(`${URL_}/storage/v1/object/public/project-files/${projectD}/references/room.png`);
      expect(plain.ok).toBe(false);
    });

    it("B can neither read, list, sign nor overwrite A's file, and cannot upload into A's project", async () => {
      expect((await bucket(users.b.client).download(`${projectD}/references/room.png`)).error).not.toBeNull();
      expect((await bucket(users.b.client).createSignedUrl(`${projectD}/references/room.png`, 60)).error).not.toBeNull();
      expect((await bucket(users.b.client).list(`${projectD}/references`)).data ?? []).toEqual([]);
      expect((await bucket(users.b.client).upload(`${projectD}/references/evil.png`, png())).error).not.toBeNull();
    });

    it("anonymous users get nothing", async () => {
      expect((await bucket(anon).download(`${projectD}/references/room.png`)).error).not.toBeNull();
      expect((await bucket(anon).upload(`${projectD}/references/anon.png`, png())).error).not.toBeNull();
    });

    it("customers cannot write generated files or malformed paths, nor payment proof before payment is due", async () => {
      expect((await bucket(users.a.client).upload(`${projectD}/generated/x.png`, png())).error).not.toBeNull();
      expect((await bucket(users.a.client).upload(`${projectD}/payment-proofs/p.png`, png())).error).not.toBeNull();
      expect((await bucket(users.a.client).upload(`not-a-project/references/x.png`, png())).error).not.toBeNull();
      expect((await bucket(users.a.client).upload(`${projectD}/other/x.png`, png())).error).not.toBeNull();
    });

    it("payment proof: A may upload while payment is awaited; B and anon cannot read it; an administrator can", async () => {
      const up = await bucket(users.a.client).upload(`${projectA}/payment-proofs/proof.png`, png(), { contentType: "image/png" });
      expect(up.error).toBeNull();
      expect((await bucket(users.b.client).download(`${projectA}/payment-proofs/proof.png`)).error).not.toBeNull();
      expect((await bucket(anon).download(`${projectA}/payment-proofs/proof.png`)).error).not.toBeNull();
      const adminSigned = await bucket(users.admin.client).createSignedUrl(`${projectA}/payment-proofs/proof.png`, 60);
      expect(adminSigned.error).toBeNull();
    });

    it("generated files written by the service role stay hidden from the owner before release", async () => {
      const up = await bucket(service).upload(`${projectA}/generated/plan.png`, png(), { contentType: "image/png" });
      expect(up.error).toBeNull();
      expect((await bucket(users.a.client).download(`${projectA}/generated/plan.png`)).error).not.toBeNull();
      expect((await bucket(users.b.client).download(`${projectA}/generated/plan.png`)).error).not.toBeNull();
      expect((await bucket(users.admin.client).createSignedUrl(`${projectA}/generated/plan.png`, 60)).error).toBeNull();
    });

    it("A can delete a draft reference; customers cannot delete payment proof", async () => {
      expect((await bucket(users.a.client).remove([`${projectA}/payment-proofs/proof.png`])).data ?? []).toEqual([]);
      const gone = await bucket(users.a.client).remove([`${projectD}/references/room.png`]);
      expect(gone.error).toBeNull();
      expect(gone.data).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------ 10. payment gate and audit
  describe("payment decision and audit trail", () => {
    it("A submits a payment claim (a claim, not proof): the project moves to PAYMENT_PROOF_SUBMITTED, unverified", async () => {
      const quote = await getLatestQuote(users.a.client, projectA);
      const res = await users.a.client
        .from("payments")
        .insert({ project_id: projectA, quote_id: quoteId, amount_claimed: quote!.totalAmount, currency: quote!.currency, method: "UPI", utr_reference: "LIVE-TEST-0001", transfer_date: new Date().toISOString().slice(0, 10) })
        .select("id")
        .single();
      expect(res.error).toBeNull();
      paymentId = res.data!.id;
      const { data } = await users.a.client.from("payments").select(PAYMENT_CUSTOMER_COLUMNS).eq("id", paymentId).single();
      expect(data).toMatchObject({ status: "PENDING_REVIEW", verified_at: null });
      expect((await getOwnedProject(users.a.client, users.a.id, projectA))?.status).toBe("PAYMENT_PROOF_SUBMITTED");
    });

    it("customers cannot read admin-only payment columns, or decide the payment themselves", async () => {
      expect((await users.a.client.from("payments").select("*")).error).not.toBeNull();
      expect((await users.a.client.from("payments").select("verified_by")).error).not.toBeNull();
      expect((await users.a.client.from("payments").update({ status: "VERIFIED" }).eq("id", paymentId)).error).not.toBeNull();
      expect((await users.a.client.rpc("admin_verify_payment", { p_payment_id: paymentId, p_confirmed_amount: 1 })).error).not.toBeNull();
      expect((await users.b.client.from("payments").select("id")).data).toEqual([]);
    });

    it("the administrator must confirm the full quoted amount, then verification advances the project", async () => {
      const wrong = await users.admin.client.rpc("admin_verify_payment", { p_payment_id: paymentId, p_confirmed_amount: 1, p_audit_note: "live test, wrong amount" });
      expect(wrong.error).not.toBeNull();
      const quote = await getLatestQuote(users.a.client, projectA);
      const ok = await users.admin.client.rpc("admin_verify_payment", { p_payment_id: paymentId, p_confirmed_amount: quote!.totalAmount, p_audit_note: "live test" });
      expect(ok.error).toBeNull();
      expect(sql(`select status from public.projects where id = '${projectA}'`)).toBe("PAYMENT_VERIFIED");
      const again = await users.admin.client.rpc("admin_verify_payment", { p_payment_id: paymentId, p_confirmed_amount: quote!.totalAmount });
      expect(again.error).not.toBeNull();
    });

    it("only an administrator can read the audit trail, and it contains the critical transitions", async () => {
      expect((await users.a.client.from("audit_events").select("id")).data ?? []).toEqual([]);
      expect((await anon.from("audit_events").select("id")).error).not.toBeNull();
      const { data } = await users.admin.client.from("audit_events").select("action, actor_id").eq("project_id", projectA);
      const actions = new Set((data ?? []).map((r) => r.action));
      for (const expected of ["project.status_changed", "quote.accepted", "payment.submitted", "payment.verified"]) {
        expect(actions.has(expected), expected).toBe(true);
      }
      const verified = (data ?? []).find((r) => r.action === "payment.verified");
      expect(verified?.actor_id).toBe(users.admin.id);
    });

    it("audit records cannot be changed or deleted, even by the service role", async () => {
      const update = await service.from("audit_events").update({ action: "tampered" }).eq("project_id", projectA).select("id");
      expect(update.error).not.toBeNull();
      const del = await service.from("audit_events").delete().eq("project_id", projectA).select("id");
      expect(del.error).not.toBeNull();
    });

    it("the administrator can read the customer's project and payment; customer B still cannot", async () => {
      expect(await getOwnedProject(users.admin.client, users.admin.id, projectA)).toBeNull(); // ownership check refuses non-owners
      expect((await users.admin.client.from("projects").select("id").eq("id", projectA)).data).toHaveLength(1);
      expect((await users.admin.client.from("payments").select(PAYMENT_CUSTOMER_COLUMNS).eq("id", paymentId)).data).toHaveLength(1);
      // verified_by and audit_note have no column grant for any session role, administrators
      // included, so an admin screen reads them with trusted server code after requireAdmin.
      expect((await users.admin.client.from("payments").select("*").eq("id", paymentId)).error).not.toBeNull();
      const full = await service.from("payments").select("verified_by, audit_note, confirmed_amount").eq("id", paymentId).single();
      expect(full.data?.verified_by).toBe(users.admin.id);
      expect((await users.b.client.from("projects").select("id").eq("id", projectA)).data).toEqual([]);
    });

    it("a verified payment still does not release anything: assets stay private and the admin must start generation", async () => {
      expect(sql(`select count(*) from public.design_assets where project_id = '${projectA}' and is_released`)).toBe("0");
      expect(sql(`select status from public.projects where id = '${projectA}'`)).toBe("PAYMENT_VERIFIED");
    });
  });
});
