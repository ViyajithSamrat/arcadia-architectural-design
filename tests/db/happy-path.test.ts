import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, as, createAdmin, createDatabase, createUser, superuser, user } from "./support/harness";

/**
 * The complete legitimate journey, using only the role that performs each step.
 * If any migration, guard or policy is wrong, this is the first test to fail.
 */
describe("legitimate workflow, end to end", () => {
  let db: PGlite;
  let customer: string;
  let admin: string;

  beforeAll(async () => {
    db = await createDatabase();
    customer = await createUser(db, "customer");
    admin = await createAdmin(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("walks DRAFT -> RELEASED and records an audit trail", async () => {
    const s = await Scenario.create(db, customer, admin);
    expect(await s.status()).toBe("DRAFT");

    await s.toBriefApproved();
    expect(await s.status()).toBe("BRIEF_APPROVED");

    await s.toQuoted();
    await s.toAwaitingPayment();
    expect(await s.status()).toBe("AWAITING_PAYMENT");

    await s.submitPayment();
    expect(await s.status()).toBe("PAYMENT_PROOF_SUBMITTED");

    await s.verify();
    expect(await s.status()).toBe("PAYMENT_VERIFIED");

    await s.startGeneration();
    await s.runSuccessfulJob();
    await s.markReadyForReview();
    expect(await s.status()).toBe("READY_FOR_REVIEW");

    await s.release();
    expect(await s.status()).toBe("RELEASED");

    const actions = await as(db, superuser, (q) =>
      q<{ action: string }>('select action from public.audit_events where project_id = $1 order by "timestamp", id', [s.projectId]),
    );
    const names = actions.map((a) => a.action);
    expect(names).toEqual(
      expect.arrayContaining([
        "project.status_changed",
        "quote.accepted",
        "payment.submitted",
        "payment.verified",
        "generation.requested",
        "generation.succeeded",
        "asset.released",
      ]),
    );

    // The owner can now see the released deliverable.
    const visible = await as(db, user(customer), (q) =>
      q("select id from public.design_assets where project_id = $1 and asset_type = 'FLOOR_PLAN_SVG'", [s.projectId]),
    );
    expect(visible).toHaveLength(1);
  });
});
