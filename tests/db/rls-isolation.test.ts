import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Scenario, anon, as, createAdmin, createDatabase, createUser, expectError, service, superuser, user, TEST_CURRENCY,
} from "./support/harness";

/**
 * Who can see and change what. Customer A and customer B each own a project; an
 * administrator and a signed-out visitor are the other roles. Every test is a
 * statement the prompt's security checklist names.
 */
describe("row level security: isolation between users and roles", () => {
  let db: PGlite;
  let a: string;
  let b: string;
  let admin: string;
  let sa: Scenario; // customer A: payment submitted, awaiting the administrator
  let sb: Scenario; // customer B: awaiting payment

  beforeAll(async () => {
    db = await createDatabase();
    a = await createUser(db, "customer-a");
    b = await createUser(db, "customer-b");
    admin = await createAdmin(db);
    sa = await Scenario.advance(db, a, admin, "proof");
    sb = await Scenario.advance(db, b, admin, "awaiting");
  });
  afterAll(async () => {
    await db.close();
  });

  describe("signed-out visitors (anon)", () => {
    it.each(["projects", "quotes", "payments", "generation_jobs", "design_assets", "pricing_rules", "site_settings", "audit_events", "admin_users"])(
      "cannot read %s",
      async (table) => {
        await expectError(as(db, anon, (q) => q(`select * from public.${table}`)), /permission denied/);
      },
    );

    it("cannot create projects or call administrator functions", async () => {
      await expectError(
        as(db, anon, (q) => q("insert into public.projects (customer_id, project_type) values ($1, 'INTERIOR')", [a])),
        /permission denied/,
      );
      await expectError(as(db, anon, (q) => q("select public.is_admin()")), /permission denied/);
      await expectError(as(db, anon, (q) => q("select * from public.admin_release_project($1)", [sa.projectId])), /permission denied/);
    });

    it("cannot read any stored file", async () => {
      await as(db, superuser, (q) =>
        q("insert into storage.objects (bucket_id, name) values ('project-files', $1)", [`${sa.projectId}/references/anon-probe.png`]),
      );
      const rows = await as(db, anon, (q) => q("select name from storage.objects"));
      expect(rows).toEqual([]);
    });
  });

  describe("customer A versus customer B", () => {
    it("each customer sees only their own project", async () => {
      const rowsA = await as(db, user(a), (q) => q<{ id: string }>("select id from public.projects"));
      const rowsB = await as(db, user(b), (q) => q<{ id: string }>("select id from public.projects"));
      expect(rowsA.map((r) => r.id)).toEqual([sa.projectId]);
      expect(rowsB.map((r) => r.id)).toEqual([sb.projectId]);
    });

    it("A cannot read B's project by its id", async () => {
      const rows = await as(db, user(a), (q) => q("select id from public.projects where id = $1", [sb.projectId]));
      expect(rows).toEqual([]);
    });

    it("A cannot read B's quotes, payments or files, and sees their own", async () => {
      expect(await as(db, user(a), (q) => q("select id from public.quotes where project_id = $1", [sb.projectId]))).toEqual([]);
      expect(await as(db, user(b), (q) => q("select id from public.quotes where project_id = $1", [sa.projectId]))).toEqual([]);
      expect(await as(db, user(a), (q) => q("select id from public.quotes where project_id = $1", [sa.projectId]))).toHaveLength(1);

      expect(await as(db, user(b), (q) => q("select id from public.payments where project_id = $1", [sa.projectId]))).toEqual([]);
      expect(
        await as(db, user(a), (q) => q("select id, status from public.payments where project_id = $1", [sa.projectId])),
      ).toHaveLength(1);
    });

    it("A cannot change B's project: the update touches no rows", async () => {
      const updated = await as(db, user(a), (q) =>
        q("update public.projects set requirements_json = '{\"hacked\":true}'::jsonb where id = $1 returning id", [sb.projectId]),
      );
      expect(updated).toEqual([]);
      const row = await as(db, superuser, (q) => q<{ r: unknown }>("select requirements_json as r from public.projects where id = $1", [sb.projectId]));
      expect(JSON.stringify(row[0].r)).not.toContain("hacked");
    });

    it("A cannot create a project owned by B", async () => {
      await expectError(
        as(db, user(a), (q) => q("insert into public.projects (customer_id, project_type) values ($1, 'LANDSCAPE')", [b])),
        /row-level security|customer_id/,
      );
    });

    it("A cannot take over B's project by changing its owner", async () => {
      await expectError(
        as(db, user(a), (q) => q("update public.projects set customer_id = $1 where id = $2", [a, sb.projectId])),
        /permission denied/,
      );
    });

    it("A cannot submit a payment against B's project or B's quote", async () => {
      await expectError(
        as(db, user(a), (q) =>
          q(
            `insert into public.payments (project_id, quote_id, amount_claimed, currency, method, utr_reference, transfer_date)
             values ($1, $2, 1, $3, 'UPI', 'X1', current_date)`,
            [sb.projectId, sb.quoteId, TEST_CURRENCY],
          ),
        ),
        // The guard trigger runs before row security and reports the same message
        // as for a project that does not exist, so nothing about B's project leaks.
        /row-level security|project not found/,
      );
    });
  });

  describe("what customers must never see", () => {
    it("hide internal administrator columns of their own payment", async () => {
      await expectError(as(db, user(a), (q) => q("select audit_note from public.payments")), /permission denied/);
      await expectError(as(db, user(a), (q) => q("select verified_by from public.payments")), /permission denied/);
      await expectError(as(db, user(a), (q) => q("select * from public.payments")), /permission denied/);
      const ok = await as(db, user(a), (q) => q("select id, status, rejection_reason from public.payments"));
      expect(ok).toHaveLength(1);
    });

    it("see no provider or job metadata, audit history, pricing or settings", async () => {
      // Make sure each table has data, so an empty result proves the policy and not an empty table.
      await as(db, superuser, async (q) => {
        await q(
          `insert into public.pricing_rules (project_type, rule_key, rate, unit, currency)
           values ('INTERIOR', 'test-rule', 1, 'unit', $1)`,
          [TEST_CURRENCY],
        );
        await q("insert into public.site_settings (key, value_json) values ('test.setting', '{\"x\":1}'::jsonb)");
      });
      for (const table of ["generation_jobs", "audit_events", "pricing_rules", "site_settings"]) {
        const rows = await as(db, user(a), (q) => q(`select * from public.${table}`));
        expect(rows, table).toEqual([]);
      }
      const auditRows = await as(db, superuser, (q) => q<{ n: number }>("select count(*)::int as n from public.audit_events"));
      expect(auditRows[0].n).toBeGreaterThan(0);
    });

    it("cannot read or edit the administrator list, or make themselves an administrator", async () => {
      await expectError(as(db, user(a), (q) => q("select * from public.admin_users")), /permission denied/);
      await expectError(as(db, user(a), (q) => q("insert into public.admin_users (user_id) values ($1)", [a])), /permission denied/);
      const me = await as(db, user(a), (q) => q<{ ok: boolean }>("select public.is_admin() as ok"));
      expect(me[0].ok).toBe(false);
    });

    it("cannot write configuration: pricing rules and settings are administrator-only", async () => {
      await expectError(
        as(db, user(a), (q) =>
          q("insert into public.site_settings (key, value_json) values ('payment.upi', '\"attacker@upi\"'::jsonb)"),
        ),
        /row-level security/,
      );
      const updated = await as(db, user(a), (q) =>
        q("update public.pricing_rules set rate = 0 returning id"),
      );
      expect(updated).toEqual([]);
    });

    it("cannot change audit history or write to it", async () => {
      await expectError(as(db, user(a), (q) => q("delete from public.audit_events")), /permission denied/);
      await expectError(as(db, user(a), (q) => q("insert into public.audit_events (action) values ('forged')")), /permission denied/);
    });
  });

  describe("administrators", () => {
    it("are recognised by the database, not by anything the user can edit", async () => {
      const row = await as(db, user(admin), (q) => q<{ ok: boolean }>("select public.is_admin() as ok"));
      expect(row[0].ok).toBe(true);
    });

    it("can read every customer's project, quote, payment and history", async () => {
      const projects = await as(db, user(admin), (q) => q("select id from public.projects"));
      expect(projects).toHaveLength(2);
      expect(await as(db, user(admin), (q) => q("select id from public.quotes"))).toHaveLength(2);
      expect(await as(db, user(admin), (q) => q("select id from public.generation_jobs"))).toEqual([]);
      const audit = await as(db, user(admin), (q) => q("select id from public.audit_events"));
      expect(audit.length).toBeGreaterThan(0);
    });

    it("manage pricing rules and settings, and every change is audited without the value", async () => {
      await as(db, user(admin), async (q) => {
        await q(
          `insert into public.pricing_rules (project_type, rule_key, rate, unit, currency)
           values ('EMPTY_PLOT', 'admin-rule', 5, 'sqft', $1)`,
          [TEST_CURRENCY],
        );
        await q("insert into public.site_settings (key, value_json) values ('admin.setting', '{\"secret-looking\":\"do-not-log\"}'::jsonb)");
        await q("update public.site_settings set value_json = '{\"changed\":true}'::jsonb where key = 'admin.setting'");
      });
      const setting = await as(db, superuser, (q) => q<{ version: number }>("select version from public.site_settings where key = 'admin.setting'"));
      expect(setting[0].version).toBe(2);

      const audit = await as(db, superuser, (q) =>
        q<{ action: string; actor_id: string; metadata_json: unknown }>(
          "select action, actor_id, metadata_json from public.audit_events where action in ('pricing_rule.changed','site_setting.changed') and actor_id = $1",
          [admin],
        ),
      );
      expect(audit.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(audit)).not.toContain("do-not-log");
    });

    it("cannot be created by the service role without leaving an audit record", async () => {
      const fresh = await createUser(db, "new-admin");
      await as(db, service, (q) => q("insert into public.admin_users (user_id, created_by) values ($1, $2)", [fresh, admin]));
      const rows = await as(db, superuser, (q) =>
        q("select id from public.audit_events where action = 'admin.granted' and metadata_json->>'user_id' = $1", [fresh]),
      );
      expect(rows).toHaveLength(1);
    });
  });
});
