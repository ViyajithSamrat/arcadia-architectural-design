import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Scenario, as, createAdmin, createDatabase, createUser, expectError, service, superuser } from "./support/harness";

const TABLES = [
  "admin_users",
  "project_status_transitions",
  "projects",
  "quotes",
  "payments",
  "generation_jobs",
  "design_assets",
  "pricing_rules",
  "site_settings",
  "audit_events",
];

describe("schema structure and privileges", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  const one = async <R,>(sql: string, params?: unknown[]) => (await as(db, superuser, (q) => q<R>(sql, params)))[0];

  it("creates exactly the expected tables, all with row level security enabled", async () => {
    const rows = await as(db, superuser, (q) =>
      q<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
      ),
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it("grants the anonymous role nothing on any table", async () => {
    for (const table of TABLES) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const row = await one<{ ok: boolean }>("select has_table_privilege('anon', $1, $2) as ok", [`public.${table}`, privilege]);
        expect(row.ok, `anon ${privilege} on ${table}`).toBe(false);
      }
    }
  });

  it("gives signed-in users no access at all to the administrator and transition tables", async () => {
    for (const table of ["admin_users", "project_status_transitions"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const row = await one<{ ok: boolean }>("select has_table_privilege('authenticated', $1, $2) as ok", [`public.${table}`, privilege]);
        expect(row.ok, `authenticated ${privilege} on ${table}`).toBe(false);
      }
    }
  });

  it("hides sensitive columns and protects workflow columns from signed-in users", async () => {
    const col = async (table: string, column: string, privilege: string) =>
      (await one<{ ok: boolean }>("select has_column_privilege('authenticated', $1, $2, $3) as ok", [`public.${table}`, column, privilege])).ok;

    // Internal administrator information is never readable by customers.
    expect(await col("payments", "audit_note", "SELECT")).toBe(false);
    expect(await col("payments", "verified_by", "SELECT")).toBe(false);
    // Customers can see the outcome and the reason.
    expect(await col("payments", "status", "SELECT")).toBe(true);
    expect(await col("payments", "rejection_reason", "SELECT")).toBe(true);
    // Workflow-controlled columns cannot be written by customers.
    expect(await col("projects", "status", "UPDATE")).toBe(false);
    expect(await col("projects", "status", "INSERT")).toBe(false);
    expect(await col("projects", "approved_at", "UPDATE")).toBe(false);
    expect(await col("projects", "customer_id", "UPDATE")).toBe(false);
    expect(await col("payments", "status", "INSERT")).toBe(false);
    expect(await col("payments", "verified_by", "INSERT")).toBe(false);
    expect(await col("design_assets", "is_released", "INSERT")).toBe(false);
    expect(await col("design_assets", "is_released", "UPDATE")).toBe(false);
    // Draft content is writable.
    expect(await col("projects", "requirements_json", "UPDATE")).toBe(true);
  });

  it("limits customers to no write access on quotes, jobs and audit history", async () => {
    for (const [table, privilege] of [
      ["quotes", "INSERT"], ["quotes", "UPDATE"], ["quotes", "DELETE"],
      ["generation_jobs", "INSERT"], ["generation_jobs", "UPDATE"], ["generation_jobs", "DELETE"],
      ["audit_events", "INSERT"], ["audit_events", "UPDATE"], ["audit_events", "DELETE"],
      ["payments", "UPDATE"], ["payments", "DELETE"], ["projects", "DELETE"],
    ] as const) {
      const row = await one<{ ok: boolean }>("select has_table_privilege('authenticated', $1, $2) as ok", [`public.${table}`, privilege]);
      expect(row.ok, `authenticated ${privilege} on ${table}`).toBe(false);
    }
  });

  it("hides internal helper functions from signed-in users and exposes only the intended API", async () => {
    const fn = async (sig: string, role: string) =>
      (await one<{ ok: boolean }>("select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, sig])).ok;

    expect(await fn("public.is_admin()", "authenticated")).toBe(true);
    expect(await fn("public.is_admin()", "anon")).toBe(false);
    for (const sig of [
      "public.admin_verify_payment(uuid, numeric, text)",
      "public.admin_reject_payment(uuid, text, text)",
      "public.admin_release_project(uuid)",
    ]) {
      expect(await fn(sig, "authenticated"), sig).toBe(true);
      expect(await fn(sig, "anon"), sig).toBe(false);
    }
    expect(await fn("app_private.project_has_verified_payment(uuid)", "authenticated")).toBe(false);
    expect(await fn("app_private.write_audit(text, uuid, uuid, uuid, jsonb)", "authenticated")).toBe(false);
    expect(await fn("app_private.write_audit(text, uuid, uuid, uuid, jsonb)", "service_role")).toBe(false);
  });

  it("encodes the spec's transition table: 24 transitions, none out of terminal states", async () => {
    const rows = await as(db, superuser, (q) =>
      q<{ from_status: string; to_status: string }>("select from_status, to_status from public.project_status_transitions"),
    );
    expect(rows).toHaveLength(24);
    expect(rows.filter((r) => r.from_status === "RELEASED" || r.from_status === "CANCELLED")).toEqual([]);
    // Cancelling after payment is verified is deliberately not allowed (refund policy is deferred).
    expect(rows.find((r) => r.from_status === "PAYMENT_VERIFIED" && r.to_status === "CANCELLED")).toBeUndefined();
    // The only way into GENERATING is from a verified payment or a failed attempt.
    expect(rows.filter((r) => r.to_status === "GENERATING").map((r) => r.from_status).sort()).toEqual(["GENERATION_FAILED", "PAYMENT_VERIFIED"]);
  });

  it("creates the indexes proposed in the spec (section 5.10)", async () => {
    const rows = await as(db, superuser, (q) =>
      q<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'public'"),
    );
    const names = new Set(rows.map((r) => r.indexname));
    for (const expected of [
      "projects_customer_created_idx", "projects_status_updated_idx", "quotes_project_created_idx",
      "payments_status_created_idx", "payments_project_created_idx", "payments_quote_idx",
      "generation_jobs_project_created_idx", "generation_jobs_status_created_idx",
      "design_assets_project_released_idx", "design_assets_job_idx",
      "audit_events_project_time_idx", "audit_events_payment_time_idx",
      "quotes_one_accepted_per_project", "payments_one_pending_per_project",
      "generation_jobs_one_active_per_project", "generation_jobs_idempotency",
    ]) {
      expect(names.has(expected), `index ${expected}`).toBe(true);
    }
  });

  it("invents no data: no rates, settings, administrators or history exist after migration", async () => {
    for (const table of ["pricing_rules", "site_settings", "admin_users", "audit_events", "projects", "payments"]) {
      const row = await one<{ n: number }>(`select count(*)::int as n from public.${table}`);
      expect(row.n, table).toBe(0);
    }
  });

  it("creates one private storage bucket limited to 5 MiB JPEG, PNG and WebP images (owner decision, Phase 4)", async () => {
    const buckets = await as(db, superuser, (q) =>
      q<{ id: string; public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null }>(
        "select id, public, file_size_limit, allowed_mime_types from storage.buckets",
      ),
    );
    expect(buckets).toEqual([
      { id: "project-files", public: false, file_size_limit: 5242880, allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] },
    ]);
  });
});

describe("data constraints", () => {
  let db: PGlite;
  let s: Scenario;
  beforeAll(async () => {
    db = await createDatabase();
    const customer = await createUser(db, "customer");
    const admin = await createAdmin(db);
    s = await Scenario.create(db, customer, admin);
    await s.toBriefApproved();
  });
  afterAll(async () => {
    await db.close();
  });

  const insertQuote = (values: { currency?: string; subtotal?: string; tax?: string; discount?: string; total?: string }) =>
    as(db, service, (q) =>
      q(
        `insert into public.quotes (project_id, currency, line_items_json, subtotal, tax_amount, discount_amount, total_amount, pricing_rule_version)
         values ($1, $2, '[]'::jsonb, $3, $4, $5, $6, 'v1')`,
        [s.projectId, values.currency ?? "XTS", values.subtotal ?? "100", values.tax ?? "0", values.discount ?? "0", values.total ?? "100"],
      ),
    );

  it("rejects a quote whose total does not equal subtotal + tax - discount", async () => {
    await expectError(insertQuote({ subtotal: "100", tax: "10", discount: "5", total: "999" }), /quotes_total_formula/);
  });

  it("accepts a quote whose total follows the formula", async () => {
    await insertQuote({ subtotal: "100", tax: "10", discount: "5", total: "105" });
  });

  it("rejects malformed currency codes and negative money", async () => {
    await expectError(insertQuote({ currency: "inr" }), /currency/);
    await expectError(insertQuote({ subtotal: "-1", total: "-1" }), /subtotal|total/);
  });

  it("rejects an asset whose path does not match its type and project", async () => {
    await expectError(
      as(db, service, (q) =>
        q("insert into public.design_assets (project_id, asset_type, storage_path, mime_type) values ($1, 'REFERENCE', 'somewhere/else.png', 'image/png')", [s.projectId]),
      ),
      /design_assets_path_matches_type/,
    );
  });

  it("rejects an unknown project status or project type", async () => {
    await expectError(as(db, superuser, (q) => q("update public.projects set status = 'DONE' where id = $1", [s.projectId])), /projects_status_check|status/);
    await expectError(as(db, superuser, (q) => q("update public.projects set project_type = 'SKYSCRAPER' where id = $1", [s.projectId])), /project_type/);
  });
});
