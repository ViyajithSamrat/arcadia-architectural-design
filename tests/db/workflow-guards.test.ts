import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Scenario, as, createAdmin, createDatabase, createUser, expectError, forceStatusWithoutGuards, service, superuser, user, TEST_CURRENCY,
} from "./support/harness";

/**
 * The workflow rules: who may change a project's state, the payment gate, the
 * administrator-only decisions, frozen quotes, release, and append-only history.
 */
describe("workflow guards", () => {
  let db: PGlite;
  let customer: string;
  let other: string;
  let admin: string;

  beforeAll(async () => {
    db = await createDatabase();
    customer = await createUser(db, "customer");
    other = await createUser(db, "other");
    admin = await createAdmin(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const advance = (upTo: Parameters<typeof Scenario.advance>[3]) => Scenario.advance(db, customer, admin, upTo);

  describe("customers cannot drive the workflow", () => {
    it("cannot set status, approval, owner or type of their own project", async () => {
      const s = await advance("draft");
      for (const change of ["status = 'BRIEF_APPROVED'", "approved_at = now()", `customer_id = '${other}'`, "project_type = 'INTERIOR'"]) {
        await expectError(
          as(db, user(customer), (q) => q(`update public.projects set ${change} where id = $1`, [s.projectId])),
          /permission denied/,
        );
      }
      expect(await s.status()).toBe("DRAFT");
    });

    it("cannot create a project that is already past DRAFT", async () => {
      await expectError(
        as(db, user(customer), (q) => q("insert into public.projects (customer_id, project_type, status) values ($1, 'INTERIOR', 'RELEASED')", [customer])),
        /permission denied/,
      );
    });

    it("can edit draft content, but only while the project is still editable", async () => {
      const s = await advance("draft");
      const edited = await as(db, user(customer), (q) =>
        q("update public.projects set requirements_json = '{\"rooms\":3}'::jsonb where id = $1 returning id", [s.projectId]),
      );
      expect(edited).toHaveLength(1);

      await s.toBriefApproved();
      const afterApproval = await as(db, user(customer), (q) =>
        q("update public.projects set requirements_json = '{\"rooms\":99}'::jsonb where id = $1 returning id", [s.projectId]),
      );
      expect(afterApproval).toEqual([]); // the approved brief is locked
      const row = await as(db, superuser, (q) => q<{ r: { rooms?: number } }>("select requirements_json as r from public.projects where id = $1", [s.projectId]));
      expect(row[0].r.rooms).toBe(3);
    });

    it("cannot create quotes, jobs or audit records", async () => {
      const s = await advance("quoted");
      await expectError(
        as(db, user(customer), (q) =>
          q(
            `insert into public.quotes (project_id, currency, line_items_json, subtotal, total_amount, pricing_rule_version)
             values ($1, $2, '[]'::jsonb, 1, 1, 'v')`,
            [s.projectId, TEST_CURRENCY],
          ),
        ),
        /permission denied/,
      );
      await expectError(
        as(db, user(customer), (q) => q("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'mock', 'v')", [s.projectId])),
        /permission denied/,
      );
    });
  });

  describe("every status change must be an allowed transition", () => {
    it("rejects jumps that skip the workflow, even from trusted server code", async () => {
      const draft = await advance("draft");
      await expectError(draft.setStatus(service, "RELEASED"), /illegal project status transition DRAFT -> RELEASED/);
      await expectError(draft.setStatus(service, "GENERATING"), /illegal project status transition DRAFT -> GENERATING/);

      const quoted = await advance("quoted");
      await expectError(quoted.setStatus(service, "GENERATING"), /illegal project status transition QUOTED -> GENERATING/);
      await expectError(quoted.setStatus(service, "PAYMENT_VERIFIED"), /illegal project status transition/);
    });

    it("rejects leaving a terminal state", async () => {
      const s = await advance("draft");
      await s.setStatus(service, "CANCELLED");
      await expectError(s.setStatus(service, "DRAFT"), /illegal project status transition CANCELLED -> DRAFT/);
      await expectError(s.setStatus(service, "BRIEF_REVIEW"), /illegal project status transition/);
    });

    it("does not allow cancelling a project whose payment is already verified", async () => {
      const s = await advance("verified");
      await expectError(s.setStatus(service, "CANCELLED"), /illegal project status transition PAYMENT_VERIFIED -> CANCELLED/);
    });

    it("requires a brief before approval, a quote before QUOTED, and an accepted quote before payment", async () => {
      const s = await advance("draft");
      await s.setStatus(service, "BRIEF_REVIEW");
      await expectError(s.setStatus(service, "BRIEF_APPROVED"), /without an English brief/);

      const t = await advance("draft");
      await t.toBriefApproved();
      await expectError(t.setStatus(service, "QUOTED"), /without a quote/);
      await t.toQuoted();
      await expectError(t.setStatus(service, "AWAITING_PAYMENT"), /requires an accepted quote/);
    });

    it("records the approval time automatically and never lets it change", async () => {
      const s = await advance("quoted");
      const row = await as(db, superuser, (q) => q<{ approved_at: string | null }>("select approved_at from public.projects where id = $1", [s.projectId]));
      expect(row[0].approved_at).not.toBeNull();
      await expectError(
        as(db, service, (q) => q("update public.projects set approved_at = now() + interval '1 day' where id = $1", [s.projectId])),
        /approved_at is write-once/,
      );
    });
  });

  describe("the payment gate: no generation without a verified payment", () => {
    it("blocks GENERATING while the payment is only submitted", async () => {
      const s = await advance("proof");
      await expectError(s.setStatus(service, "GENERATING"), /illegal project status transition PAYMENT_PROOF_SUBMITTED -> GENERATING/);
    });

    it("blocks GENERATING after a rejection", async () => {
      const s = await advance("proof");
      await as(db, user(admin), (q) => q("select * from public.admin_reject_payment($1, 'amount does not match')", [s.paymentId]));
      expect(await s.status()).toBe("PAYMENT_REJECTED");
      await expectError(s.setStatus(service, "GENERATING"), /illegal project status transition PAYMENT_REJECTED -> GENERATING/);
    });

    it("still blocks GENERATING if project data were forged into PAYMENT_VERIFIED without a verified payment", async () => {
      const s = await advance("proof");
      await forceStatusWithoutGuards(db, s.projectId, "PAYMENT_VERIFIED"); // simulate corrupted data
      await expectError(s.setStatus(service, "GENERATING"), /generation requires a verified payment/);
    });

    it("cannot create a generation job without a verified payment, whatever the project status", async () => {
      const s = await advance("proof");
      await forceStatusWithoutGuards(db, s.projectId, "GENERATING");
      await expectError(
        as(db, service, (q) => q("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'mock', 'v')", [s.projectId])),
        /generation requires a verified payment/,
      );
    });

    it("cannot create a generation job unless the project is GENERATING", async () => {
      const s = await advance("verified");
      await expectError(
        as(db, service, (q) => q("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'mock', 'v')", [s.projectId])),
        /only while the project is GENERATING/,
      );
    });

    it("allows generation only after verification, and then it succeeds", async () => {
      const s = await advance("verified");
      await s.startGeneration();
      await s.runSuccessfulJob();
      expect(await s.status()).toBe("GENERATING");
    });

    it("stores no generated asset unless the payment is verified", async () => {
      const s = await advance("proof");
      await forceStatusWithoutGuards(db, s.projectId, "GENERATING");
      // A job cannot exist (blocked above), so a generated asset cannot be linked to one either.
      await expectError(
        as(db, service, (q) =>
          q(
            `insert into public.design_assets (project_id, generation_job_id, asset_type, storage_path, mime_type)
             values ($1, gen_random_uuid(), 'FLOOR_PLAN_SVG', $2, 'image/svg+xml')`,
            [s.projectId, `${s.projectId}/generated/x.svg`],
          ),
        ),
        /violates foreign key|belongs to a different project/,
      );
    });
  });

  describe("payment decisions belong to administrators", () => {
    it("lets a customer submit a pending claim only, and moves the project to PAYMENT_PROOF_SUBMITTED", async () => {
      const s = await advance("awaiting");
      await expectError(
        as(db, user(customer), (q) =>
          q(
            `insert into public.payments (project_id, quote_id, amount_claimed, currency, method, utr_reference, transfer_date, status)
             values ($1, $2, 1000, $3, 'UPI', 'R1', current_date, 'VERIFIED')`,
            [s.projectId, s.quoteId, TEST_CURRENCY],
          ),
        ),
        /permission denied/,
      );
      await s.submitPayment();
      expect(await s.status()).toBe("PAYMENT_PROOF_SUBMITTED");
      const row = await as(db, superuser, (q) => q<{ status: string }>("select status from public.payments where id = $1", [s.paymentId]));
      expect(row[0].status).toBe("PENDING_REVIEW");
    });

    it("refuses a payment before the project is awaiting payment", async () => {
      const s = await advance("quoted");
      await expectError(s.submitPayment(), /row-level security|only while awaiting payment/);
    });

    it("allows only one pending payment per project", async () => {
      const s = await advance("proof");
      await expectError(
        as(db, user(customer), (q) =>
          q(
            `insert into public.payments (project_id, quote_id, amount_claimed, currency, method, utr_reference, transfer_date)
             values ($1, $2, 1000, $3, 'UPI', 'DUP', current_date)`,
            [s.projectId, s.quoteId, TEST_CURRENCY],
          ),
        ),
        /row-level security|only while awaiting payment/,
      );
    });

    it("refuses verification from a customer, from a non-administrator, and by direct update", async () => {
      const s = await advance("proof");
      await expectError(as(db, user(customer), (q) => q("select * from public.admin_verify_payment($1, 1000)", [s.paymentId])), /administrator access required/);
      await expectError(as(db, user(other), (q) => q("select * from public.admin_verify_payment($1, 1000)", [s.paymentId])), /administrator access required/);
      await expectError(as(db, user(customer), (q) => q("update public.payments set status = 'VERIFIED' where id = $1", [s.paymentId])), /permission denied/);
      expect(await s.status()).toBe("PAYMENT_PROOF_SUBMITTED");
    });

    it("refuses a forged decision from trusted server code that does not name an administrator", async () => {
      const s = await advance("proof");
      await expectError(
        as(db, service, (q) =>
          q("update public.payments set status = 'VERIFIED', confirmed_amount = 1000, verified_by = $2 where id = $1", [s.paymentId, other]),
        ),
        /must be made by an administrator/,
      );
      await expectError(
        as(db, service, (q) => q("update public.payments set status = 'VERIFIED', confirmed_amount = 1000 where id = $1", [s.paymentId])),
        /payments_decision_consistent|must be made by an administrator/,
      );
      expect(await s.status()).toBe("PAYMENT_PROOF_SUBMITTED");
    });

    it("refuses to move a project into a payment state directly", async () => {
      const s = await advance("proof");
      await expectError(s.setStatus(service, "PAYMENT_VERIFIED"), /payment states change only through/);
      await expectError(s.setStatus(service, "PAYMENT_REJECTED"), /payment states change only through/);
    });

    it("verifies only when the confirmed amount equals the accepted quote total", async () => {
      const s = await advance("proof");
      await expectError(
        as(db, user(admin), (q) => q("select * from public.admin_verify_payment($1, 999.99)", [s.paymentId])),
        /confirmed amount must equal the accepted quote total/,
      );
      expect(await s.status()).toBe("PAYMENT_PROOF_SUBMITTED");
      await s.verify("1000.00");
      expect(await s.status()).toBe("PAYMENT_VERIFIED");
    });

    it("records who verified and when, and shows the customer neither the name nor the note", async () => {
      const s = await advance("verified");
      const row = await as(db, superuser, (q) =>
        q<{ verified_by: string; verified_at: string; audit_note: string }>("select verified_by, verified_at, audit_note from public.payments where id = $1", [s.paymentId]),
      );
      expect(row[0].verified_by).toBe(admin);
      expect(row[0].verified_at).not.toBeNull();
      expect(row[0].audit_note).toBe("checked in test");
      await expectError(as(db, user(customer), (q) => q("select verified_by from public.payments where id = $1", [s.paymentId])), /permission denied/);
    });

    it("needs a reason to reject, then lets the customer resubmit", async () => {
      const s = await advance("proof");
      await expectError(as(db, user(admin), (q) => q("select * from public.admin_reject_payment($1, '   ')", [s.paymentId])), /rejection reason is required/);
      await as(db, user(admin), (q) => q("select * from public.admin_reject_payment($1, 'UTR not found in the account')", [s.paymentId]));
      expect(await s.status()).toBe("PAYMENT_REJECTED");

      const reason = await as(db, user(customer), (q) => q<{ rejection_reason: string }>("select rejection_reason from public.payments where id = $1", [s.paymentId]));
      expect(reason[0].rejection_reason).toBe("UTR not found in the account");

      await s.submitPayment(); // a new claim after a rejection
      expect(await s.status()).toBe("PAYMENT_PROOF_SUBMITTED");
    });

    it("treats a decision as final and submitted evidence as immutable", async () => {
      const s = await advance("verified");
      await expectError(
        as(db, user(admin), (q) => q("select * from public.admin_reject_payment($1, 'changed my mind')", [s.paymentId])),
        /not found or not awaiting review/,
      );
      await expectError(
        as(db, service, (q) => q("update public.payments set amount_claimed = 1 where id = $1", [s.paymentId])),
        /evidence is immutable/,
      );
      await expectError(
        as(db, service, (q) => q("update public.payments set status = 'PENDING_REVIEW', verified_by = null, verified_at = null, confirmed_amount = null where id = $1", [s.paymentId])),
        /decision is final/,
      );
    });
  });

  describe("quotes are frozen once accepted", () => {
    it("cannot be edited, deleted or accepted twice", async () => {
      const s = await advance("awaiting");
      await expectError(as(db, service, (q) => q("update public.quotes set total_amount = 1, subtotal = 1 where id = $1", [s.quoteId])), /accepted quote is frozen/);
      await expectError(as(db, service, (q) => q("delete from public.quotes where id = $1", [s.quoteId])), /accepted quote cannot be deleted/);
    });

    it("cannot be accepted unless the project is QUOTED, and never twice per project", async () => {
      const s = await advance("quoted");
      const second = await as(db, service, (q) =>
        q<{ id: string }>(
          `insert into public.quotes (project_id, currency, line_items_json, subtotal, total_amount, pricing_rule_version)
           values ($1, $2, '[]'::jsonb, 500, 500, 'v2') returning id`,
          [s.projectId, TEST_CURRENCY],
        ),
      );
      await as(db, service, (q) => q("update public.quotes set accepted_at = now() where id = $1", [s.quoteId]));
      await expectError(
        as(db, service, (q) => q("update public.quotes set accepted_at = now() where id = $1", [second[0].id])),
        /quotes_one_accepted_per_project/,
      );
    });

    it("cannot be accepted after it has expired", async () => {
      const s = await advance("draft");
      await s.toBriefApproved();
      // A quote that was created two hours ago and was valid for one hour.
      const q1 = await as(db, service, (q) =>
        q<{ id: string }>(
          `insert into public.quotes (project_id, currency, line_items_json, subtotal, total_amount, pricing_rule_version, created_at, valid_until)
           values ($1, $2, '[]'::jsonb, 1, 1, 'v', now() - interval '2 hours', now() - interval '1 hour') returning id`,
          [s.projectId, TEST_CURRENCY],
        ),
      );
      await s.setStatus(service, "QUOTED");
      await expectError(
        as(db, service, (q) => q("update public.quotes set accepted_at = now() where id = $1", [q1[0].id])),
        /has expired/,
      );
    });
  });

  describe("generation jobs", () => {
    it("allow one active job per project and one use per idempotency key", async () => {
      const s = await advance("verified");
      await s.startGeneration();
      await as(db, service, (q) => q("insert into public.generation_jobs (project_id, provider, prompt_version, idempotency_key) values ($1, 'mock', 'v', 'key-1')", [s.projectId]));
      await expectError(
        as(db, service, (q) => q("insert into public.generation_jobs (project_id, provider, prompt_version, idempotency_key) values ($1, 'mock', 'v', 'key-2')", [s.projectId])),
        /generation_jobs_one_active_per_project/,
      );
    });

    it("only move forward through their own states", async () => {
      const s = await advance("verified");
      await s.startGeneration();
      const job = await as(db, service, (q) => q<{ id: string }>("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'mock', 'v') returning id", [s.projectId]));
      await expectError(as(db, service, (q) => q("update public.generation_jobs set status = 'SUCCEEDED' where id = $1", [job[0].id])), /illegal generation job transition QUEUED -> SUCCEEDED/);
      await as(db, service, (q) => q("update public.generation_jobs set status = 'RUNNING' where id = $1", [job[0].id]));
      await as(db, service, (q) => q("update public.generation_jobs set status = 'FAILED', error_code = 'PROVIDER_TIMEOUT' where id = $1", [job[0].id]));
      await expectError(as(db, service, (q) => q("update public.generation_jobs set status = 'RUNNING' where id = $1", [job[0].id])), /illegal generation job transition FAILED -> RUNNING/);
    });

    it("lets a failed attempt be retried as a new job", async () => {
      const s = await advance("verified");
      await s.startGeneration();
      const job = await as(db, service, (q) => q<{ id: string }>("insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'mock', 'v') returning id", [s.projectId]));
      await as(db, service, (q) => q("update public.generation_jobs set status = 'RUNNING' where id = $1", [job[0].id]));
      await as(db, service, (q) => q("update public.generation_jobs set status = 'FAILED' where id = $1", [job[0].id]));
      await s.setStatus(service, "GENERATION_FAILED");
      await s.setStatus(service, "GENERATING");
      await s.runSuccessfulJob();
      await s.markReadyForReview();
      expect(await s.status()).toBe("READY_FOR_REVIEW");
    });

    it("cannot be marked READY_FOR_REVIEW without a succeeded job and generated assets", async () => {
      const s = await advance("verified");
      await s.startGeneration();
      await expectError(s.setStatus(service, "READY_FOR_REVIEW"), /requires a succeeded job and generated assets/);
      await expectError(s.setStatus(service, "GENERATION_FAILED"), /requires a failed generation job/);
    });
  });

  describe("release", () => {
    it("is refused for non-administrators and for trusted server code acting alone", async () => {
      const s = await advance("ready");
      await expectError(as(db, user(customer), (q) => q("select * from public.admin_release_project($1)", [s.projectId])), /administrator access required/);
      await expectError(as(db, user(other), (q) => q("select * from public.admin_release_project($1)", [s.projectId])), /administrator access required/);
      await expectError(s.setStatus(service, "RELEASED"), /only an administrator can release a project/);
      expect(await s.status()).toBe("READY_FOR_REVIEW");
    });

    it("is refused unless the project is ready for review", async () => {
      const s = await advance("generating");
      await expectError(as(db, user(admin), (q) => q("select * from public.admin_release_project($1)", [s.projectId])), /not found or not ready for review/);
    });

    it("releases the deliverables atomically, and nobody can flip the release flag directly", async () => {
      const s = await advance("ready");
      await expectError(as(db, service, (q) => q("update public.design_assets set is_released = true where project_id = $1", [s.projectId])), /only be set by the release workflow/);
      await expectError(as(db, user(admin), (q) => q("update public.design_assets set is_released = true where project_id = $1", [s.projectId])), /permission denied/);
      await s.release();
      const row = await as(db, superuser, (q) => q<{ is_released: boolean }>("select is_released from public.design_assets where project_id = $1", [s.projectId]));
      expect(row.every((r) => r.is_released)).toBe(true);
      await expectError(as(db, service, (q) => q("delete from public.design_assets where project_id = $1", [s.projectId])), /released assets cannot be deleted/);
    });
  });

  describe("customer file records", () => {
    it("let a customer add reference files and payment proof only where and when allowed", async () => {
      const s = await advance("draft");
      const ref = `${s.projectId}/references/room.jpg`;
      await as(db, user(customer), (q) =>
        q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type) values ($1, 'REFERENCE', $2, 'image/jpeg')", [s.projectId, ref]),
      );
      // Not generated types, never pre-released.
      await expectError(
        as(db, user(customer), (q) =>
          q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type, is_released) values ($1, 'REFERENCE', $2, 'image/jpeg', true)", [s.projectId, `${s.projectId}/references/x.jpg`]),
        ),
        /permission denied/,
      );
      await expectError(
        as(db, user(customer), (q) =>
          q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type) values ($1, 'EXTERIOR_CONCEPT', $2, 'image/png')", [s.projectId, `${s.projectId}/generated/fake.png`]),
        ),
        /row-level security|can add only reference/,
      );
      // Payment proof only while awaiting payment.
      await expectError(
        as(db, user(customer), (q) =>
          q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type) values ($1, 'PAYMENT_PROOF', $2, 'image/png')", [s.projectId, `${s.projectId}/payment-proofs/p.png`]),
        ),
        /only while awaiting payment/,
      );
      // Reference files cannot be added once the brief is approved.
      await s.toBriefApproved();
      await expectError(
        as(db, user(customer), (q) =>
          q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type) values ($1, 'REFERENCE', $2, 'image/jpeg')", [s.projectId, `${s.projectId}/references/late.jpg`]),
        ),
        /only while the project is editable/,
      );
    });

    it("let a customer remove a draft reference but never payment proof", async () => {
      const s = await advance("draft");
      const ref = `${s.projectId}/references/remove-me.jpg`;
      await as(db, user(customer), (q) =>
        q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type) values ($1, 'REFERENCE', $2, 'image/jpeg')", [s.projectId, ref]),
      );
      const removed = await as(db, user(customer), (q) => q("delete from public.design_assets where storage_path = $1 returning id", [ref]));
      expect(removed).toHaveLength(1);

      await s.toBriefApproved();
      await s.toQuoted();
      await s.toAwaitingPayment();
      const proof = `${s.projectId}/payment-proofs/proof.png`;
      await as(db, user(customer), (q) =>
        q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type) values ($1, 'PAYMENT_PROOF', $2, 'image/png')", [s.projectId, proof]),
      );
      const kept = await as(db, user(customer), (q) => q("delete from public.design_assets where storage_path = $1 returning id", [proof]));
      expect(kept).toEqual([]);
    });
  });

  describe("audit history", () => {
    it("is append-only for everyone, including the service role and the database owner", async () => {
      const s = await advance("proof");
      const rows = await as(db, superuser, (q) => q<{ id: string }>("select id from public.audit_events where project_id = $1", [s.projectId]));
      expect(rows.length).toBeGreaterThan(0);
      for (const actor of [service, superuser]) {
        await expectError(as(db, actor, (q) => q("update public.audit_events set action = 'edited' where id = $1", [rows[0].id])), /append-only/);
        await expectError(as(db, actor, (q) => q("delete from public.audit_events where id = $1", [rows[0].id])), /append-only/);
        await expectError(as(db, actor, (q) => q("truncate public.audit_events")), /append-only/);
      }
    });

    it("names the administrator on payment decisions and omits sensitive content", async () => {
      const s = await advance("verified");
      const rows = await as(db, superuser, (q) =>
        q<{ actor_id: string; metadata_json: Record<string, unknown> }>("select actor_id, metadata_json from public.audit_events where payment_id = $1 and action = 'payment.verified'", [s.paymentId]),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_id).toBe(admin);
      expect(Object.keys(rows[0].metadata_json)).not.toContain("audit_note");
    });
  });
});
