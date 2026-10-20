import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, as, superuser } from "./support/harness";

/**
 * Evidence for the performance policy: an index is kept only if the expected query
 * actually uses it. Each query is planned twice on a realistic data volume:
 *   before = the index dropped (inside a transaction that is rolled back)
 *   after  = the index in place
 * and the test asserts the plan really changes from a table scan to the index.
 */

const SCALE = { users: 2_000, projects: 20_000, audit: 40_000 };

type Case = {
  name: string;
  sql: string;
  indexes: string[]; // dropped together for the "before" plan
  expectIndex: RegExp; // what the "after" plan must use
};

describe("indexes are used by the queries they exist for", () => {
  let db: PGlite;
  let projectId: string;
  let customerId: string;

  beforeAll(async () => {
    db = await createDatabase();
    await as(db, superuser, async (q) => {
      // Bulk-load without running guard triggers; the data still obeys every CHECK constraint.
      // Values are derived from the row number so the volume is varied and repeatable
      // (a subquery that ignores the row would be evaluated once and make every row identical).
      await q("set local session_replication_role = replica");
      await q(`insert into auth.users (id, email) select gen_random_uuid(), 'u' || g || '@example.test' from generate_series(1, ${SCALE.users}) g`);
      await q("insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000aa', 'index-admin@example.test')");
      await q(`
        with ua as (select array_agg(id order by id) as ids from auth.users where email like 'u%')
        insert into public.projects (customer_id, project_type, status, approved_at, created_at, updated_at)
        select ua.ids[1 + (g % ${SCALE.users})], 'INTERIOR', s.status,
               case when s.status = 'DRAFT' then null else now() end,
               now() - (random() * interval '90 days'), now() - (random() * interval '30 days')
        from generate_series(1, ${SCALE.projects}) g
        cross join ua
        cross join lateral (select (array['DRAFT','BRIEF_REVIEW','RELEASED','RELEASED','RELEASED'])[1 + (g % 5)] as status) s`);
      await q(`
        insert into public.quotes (project_id, currency, line_items_json, subtotal, total_amount, pricing_rule_version, accepted_at)
        select id, 'XTS', '[]'::jsonb, 100, 100, 'v', now() from public.projects where status = 'RELEASED'`);
      await q(`
        insert into public.payments (project_id, quote_id, amount_claimed, currency, method, utr_reference, transfer_date,
                                     status, verified_by, verified_at, rejection_reason, created_at)
        select p.id, qt.id, 100, 'XTS', 'UPI', 'R' || n, current_date,
               case when n % 50 = 0 then 'PENDING_REVIEW' else 'REJECTED' end,
               case when n % 50 = 0 then null else '00000000-0000-4000-8000-0000000000aa'::uuid end,
               case when n % 50 = 0 then null else now() end,
               case when n % 50 = 0 then null else 'load test' end,
               now() - (random() * interval '60 days')
        from (select p.*, row_number() over () as n from public.projects p where p.status = 'RELEASED') p
        join public.quotes qt on qt.project_id = p.id`);
      await q(`
        insert into public.generation_jobs (project_id, status, provider, prompt_version, created_at)
        select id, (array['SUCCEEDED','SUCCEEDED','SUCCEEDED','FAILED','QUEUED'])[1 + (n % 5)], 'mock', 'v', now() - (random() * interval '60 days')
        from (select id, row_number() over () as n from public.projects where status = 'RELEASED') x`);
      await q(`
        insert into public.design_assets (project_id, asset_type, storage_path, mime_type, created_at)
        select p.id, 'REFERENCE', p.id::text || '/references/' || n || '.jpg', 'image/jpeg', now() - (random() * interval '60 days')
        from public.projects p cross join generate_series(1, 2) n`);
      // AI usage ledger: mostly OpenRouter requests, few Gnani credits, spread over 60 days.
      await q(`
        with ua as (select array_agg(id order by id) as ids from auth.users where email like 'u%')
        insert into public.ai_usage (customer_id, provider, operation, unit, units_estimated, status, created_at)
        select ua.ids[1 + (g % ${SCALE.users})],
               case when g % 100 = 0 then 'gnani' else 'openrouter' end,
               case when g % 100 = 0 then 'stt' else 'brief' end,
               case when g % 100 = 0 then 'credit' else 'request' end,
               1, 'SUCCEEDED', now() - (random() * interval '60 days')
        from generate_series(1, 30000) g cross join ua`);
      await q(`
        with pa as (select array_agg(id order by id) as ids from public.projects)
        insert into public.audit_events (action, project_id, "timestamp")
        select 'project.status_changed', pa.ids[1 + (g % ${SCALE.projects})], now() - (random() * interval '60 days')
        from generate_series(1, ${SCALE.audit}) g cross join pa`);
    });
    await db.exec("analyze");
    const sample = await as(db, superuser, (q) =>
      q<{ id: string; customer_id: string }>("select id, customer_id from public.projects where status = 'RELEASED' limit 1"),
    );
    projectId = sample[0].id;
    customerId = sample[0].customer_id;
  });
  afterAll(async () => {
    await db.close();
  });

  const cases = (): Case[] => [
    {
      name: "customer's project list (customer_id, newest first)",
      sql: `select * from public.projects where customer_id = '${customerId}' order by created_at desc`,
      indexes: ["projects_customer_created_idx"],
      expectIndex: /projects_customer_created_idx/,
    },
    {
      name: "administrator queue by project status (oldest update first)",
      sql: `select * from public.projects where status = 'BRIEF_REVIEW' order by updated_at desc limit 25`,
      indexes: ["projects_status_updated_idx"],
      expectIndex: /projects_status_updated_idx/,
    },
    {
      name: "administrator payment queue (pending, oldest first)",
      sql: `select * from public.payments where status = 'PENDING_REVIEW' order by created_at limit 25`,
      indexes: ["payments_status_created_idx", "payments_one_pending_per_project"],
      expectIndex: /payments_status_created_idx|payments_one_pending_per_project/,
    },
    {
      name: "administrator payment queue (recent decisions, newest first, one decided status)",
      sql: `select * from public.payments where status = 'REJECTED' order by created_at desc limit 20`,
      indexes: ["payments_status_created_idx"],
      expectIndex: /payments_status_created_idx/,
    },
    {
      name: "a project's payment history",
      sql: `select * from public.payments where project_id = '${projectId}' order by created_at desc`,
      indexes: ["payments_project_created_idx", "payments_one_pending_per_project"],
      expectIndex: /payments_project_created_idx|payments_one_pending_per_project/,
    },
    {
      name: "quotes of a project",
      sql: `select * from public.quotes where project_id = '${projectId}' order by created_at desc`,
      indexes: ["quotes_project_created_idx", "quotes_one_accepted_per_project"],
      expectIndex: /quotes_project_created_idx|quotes_one_accepted_per_project/,
    },
    {
      name: "administrator generation queue (active jobs)",
      sql: `select * from public.generation_jobs where status in ('QUEUED','RUNNING') order by created_at desc limit 25`,
      indexes: ["generation_jobs_status_created_idx", "generation_jobs_one_active_per_project"],
      expectIndex: /generation_jobs_status_created_idx|generation_jobs_one_active_per_project/,
    },
    {
      name: "results gallery: a project's released assets",
      sql: `select * from public.design_assets where project_id = '${projectId}' and is_released order by created_at desc`,
      indexes: ["design_assets_project_released_idx"],
      expectIndex: /design_assets_project_released_idx/,
    },
    {
      name: "budget guard: one customer's recent usage (per-customer limit)",
      sql: `select coalesce(sum(greatest(units_estimated, coalesce(units_reported, 0))), 0) from public.ai_usage
            where customer_id = '${customerId}' and provider = 'openrouter' and unit = 'request'
              and status <> 'NOT_SENT' and created_at > now() - interval '60 minutes'`,
      indexes: ["ai_usage_customer_idx", "ai_usage_provider_time_idx"],
      expectIndex: /ai_usage_customer_idx|ai_usage_provider_time_idx/,
    },
    {
      name: "budget guard: provider-wide usage in the last 24 hours (daily cap)",
      sql: `select coalesce(sum(greatest(units_estimated, coalesce(units_reported, 0))), 0) from public.ai_usage
            where provider = 'openrouter' and unit = 'request' and status <> 'NOT_SENT' and created_at > now() - interval '24 hours'`,
      indexes: ["ai_usage_provider_time_idx"],
      expectIndex: /ai_usage_provider_time_idx/,
    },
    {
      name: "audit history of a project",
      sql: `select * from public.audit_events where project_id = '${projectId}' order by "timestamp" desc`,
      indexes: ["audit_events_project_time_idx"],
      expectIndex: /audit_events_project_time_idx/,
    },
  ];

  const explain = async (sql: string): Promise<string> => {
    const rows = await db.query<{ "QUERY PLAN": string }>(`explain (analyze, costs off, timing off, summary off) ${sql}`);
    return rows.rows.map((r) => r["QUERY PLAN"]).join("\n");
  };

  it.each(cases().map((c, i) => [i, c.name] as const))("query %i: %s", async (i) => {
    const c = cases()[i];

    // Plan with the index.
    const after = await explain(c.sql);

    // Plan without it, inside a transaction that is rolled back.
    await db.exec("begin");
    let before: string;
    try {
      for (const index of c.indexes) await db.exec(`drop index if exists public.${index}`);
      before = await explain(c.sql);
    } finally {
      await db.exec("rollback");
    }

    const summarize = (plan: string) => plan.split("\n").map((l) => l.trim()).filter((l) => /Scan|Sort/.test(l)).join(" > ");
    console.log(`\n[${c.name}]\n   before: ${summarize(before)}\n   after : ${summarize(after)}`);

    expect(after, "plan with the index").toMatch(c.expectIndex);
    expect(before, "plan without the index").not.toMatch(c.expectIndex);
    expect(before, "plan without the index scans the whole table").toMatch(/Seq Scan/);
  });
});
