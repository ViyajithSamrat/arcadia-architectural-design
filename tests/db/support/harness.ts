import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Database security test harness.
 *
 * Runs the real migrations in supabase/migrations against an in-process Postgres
 * (PGlite) on top of a test-only stand-in for Supabase's auth/storage objects.
 * Each call to `as()` is one transaction executed as a given database role, the
 * same way Supabase's API gateway runs a request.
 */

const ROOT = process.cwd();

export type Actor =
  | { kind: "anon" }
  | { kind: "service" }
  | { kind: "super" }
  | { kind: "user"; id: string };

export type Query = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

export const anon: Actor = { kind: "anon" };
export const service: Actor = { kind: "service" };
export const superuser: Actor = { kind: "super" };
export const user = (id: string): Actor => ({ kind: "user", id });

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(path.join(ROOT, "tests/db/support/supabase-shim.sql"), "utf8"));
  const dir = path.join(ROOT, "supabase/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(dir, file), "utf8"));
  }
  return db;
}

/** Runs `fn` as `actor` in one transaction. Commits on success, rolls back on error. */
export async function as<T>(db: PGlite, actor: Actor, fn: (q: Query) => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    if (actor.kind === "anon") await db.exec("set local role anon");
    else if (actor.kind === "service") await db.exec("set local role service_role");
    else if (actor.kind === "user") {
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [actor.id]);
    }
    const q: Query = async <R,>(sql: string, params?: unknown[]) =>
      (await db.query(sql, params)).rows as R[];
    const result = await fn(q);
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback").catch(() => undefined);
    throw error;
  }
}

/** Asserts that `promise` rejects with a message matching `pattern`. */
export async function expectError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message: string | undefined;
  try {
    await promise;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === undefined) throw new Error(`expected an error matching ${pattern}, but the statement succeeded`);
  if (!pattern.test(message)) throw new Error(`expected error matching ${pattern}, got: ${message}`);
}

export async function createUser(db: PGlite, label: string): Promise<string> {
  const id = randomUUID();
  await as(db, superuser, (q) => q("insert into auth.users (id, email) values ($1, $2)", [id, `${label}-${id.slice(0, 8)}@example.test`]));
  return id;
}

export async function createAdmin(db: PGlite, label = "admin"): Promise<string> {
  const id = await createUser(db, label);
  await as(db, superuser, (q) => q("insert into public.admin_users (user_id) values ($1)", [id]));
  return id;
}

/**
 * Forces a project into a status WITHOUT running the guard triggers. Used only to
 * simulate corrupted or forged data, to prove the later checks still hold.
 */
export async function forceStatusWithoutGuards(db: PGlite, projectId: string, status: string): Promise<void> {
  await as(db, superuser, async (q) => {
    await q("set local session_replication_role = replica");
    await q("update public.projects set status = $2, approved_at = coalesce(approved_at, now()) where id = $1", [projectId, status]);
  });
}

/** ISO 4217 test currency code, so no real currency is implied by the fixtures. */
export const TEST_CURRENCY = "XTS";

/**
 * Drives one project through the real workflow, one legitimate step at a time, so a
 * test can stop at any state. Every step runs as the role that would perform it.
 */
export class Scenario {
  projectId = "";
  quoteId = "";
  paymentId = "";
  jobId = "";

  private constructor(
    readonly db: PGlite,
    readonly customerId: string,
    readonly adminId: string,
  ) {}

  static async create(db: PGlite, customerId: string, adminId: string, type = "EMPTY_PLOT"): Promise<Scenario> {
    const s = new Scenario(db, customerId, adminId);
    const rows = await as(db, user(customerId), (q) =>
      q<{ id: string }>(
        `insert into public.projects (customer_id, project_type, requirements_json)
         values ($1, $2, '{"note":"demo requirement"}'::jsonb) returning id`,
        [customerId, type],
      ),
    );
    s.projectId = rows[0].id;
    return s;
  }

  async status(): Promise<string> {
    const rows = await as(this.db, superuser, (q) =>
      q<{ status: string }>("select status from public.projects where id = $1", [this.projectId]),
    );
    return rows[0].status;
  }

  async setStatus(actor: Actor, status: string): Promise<void> {
    await as(this.db, actor, (q) => q("update public.projects set status = $2 where id = $1", [this.projectId, status]));
  }

  async toBriefApproved(): Promise<this> {
    await as(this.db, service, (q) =>
      q("update public.projects set status = 'BRIEF_REVIEW', english_brief_text = 'A demo English brief' where id = $1", [this.projectId]),
    );
    await this.setStatus(service, "BRIEF_APPROVED");
    return this;
  }

  async toQuoted(total = "1000.00"): Promise<this> {
    const rows = await as(this.db, service, (q) =>
      q<{ id: string }>(
        `insert into public.quotes (project_id, currency, line_items_json, subtotal, total_amount, pricing_rule_version)
         values ($1, $2, '[{"label":"demo line"}]'::jsonb, $3, $3, 'test-v1') returning id`,
        [this.projectId, TEST_CURRENCY, total],
      ),
    );
    this.quoteId = rows[0].id;
    await this.setStatus(service, "QUOTED");
    return this;
  }

  async toAwaitingPayment(): Promise<this> {
    await as(this.db, service, (q) => q("update public.quotes set accepted_at = now() where id = $1", [this.quoteId]));
    await this.setStatus(service, "AWAITING_PAYMENT");
    return this;
  }

  async submitPayment(claimed = "1000.00"): Promise<this> {
    const rows = await as(this.db, user(this.customerId), (q) =>
      q<{ id: string }>(
        `insert into public.payments (project_id, quote_id, amount_claimed, currency, method, utr_reference, transfer_date)
         values ($1, $2, $3, $4, 'UPI', 'TESTREF123', current_date) returning id`,
        [this.projectId, this.quoteId, claimed, TEST_CURRENCY],
      ),
    );
    this.paymentId = rows[0].id;
    return this;
  }

  async verify(confirmed = "1000.00"): Promise<this> {
    await as(this.db, user(this.adminId), (q) => q("select * from public.admin_verify_payment($1, $2, 'checked in test')", [this.paymentId, confirmed]));
    return this;
  }

  async startGeneration(): Promise<this> {
    await this.setStatus(service, "GENERATING");
    return this;
  }

  /** Creates a job, runs it to SUCCEEDED and stores one generated asset. */
  async runSuccessfulJob(): Promise<this> {
    await as(this.db, service, async (q) => {
      const job = await q<{ id: string }>(
        "insert into public.generation_jobs (project_id, provider, prompt_version) values ($1, 'mock', 'test-v1') returning id",
        [this.projectId],
      );
      this.jobId = job[0].id;
      await q("update public.generation_jobs set status = 'RUNNING' where id = $1", [this.jobId]);
      await q(
        `insert into public.design_assets (project_id, generation_job_id, asset_type, storage_path, mime_type)
         values ($1, $2, 'FLOOR_PLAN_SVG', $3, 'image/svg+xml')`,
        [this.projectId, this.jobId, `${this.projectId}/generated/plan.svg`],
      );
      await q("update public.generation_jobs set status = 'SUCCEEDED' where id = $1", [this.jobId]);
    });
    return this;
  }

  async markReadyForReview(): Promise<this> {
    await this.setStatus(service, "READY_FOR_REVIEW");
    return this;
  }

  async release(actorId = this.adminId): Promise<void> {
    await as(this.db, user(actorId), (q) => q("select * from public.admin_release_project($1)", [this.projectId]));
  }

  /** Walks the whole legitimate path up to a named stage. */
  static async advance(
    db: PGlite,
    customerId: string,
    adminId: string,
    upTo: "draft" | "quoted" | "awaiting" | "proof" | "verified" | "generating" | "ready" | "released",
  ): Promise<Scenario> {
    const s = await Scenario.create(db, customerId, adminId);
    if (upTo === "draft") return s;
    await s.toBriefApproved();
    await s.toQuoted();
    if (upTo === "quoted") return s;
    await s.toAwaitingPayment();
    if (upTo === "awaiting") return s;
    await s.submitPayment();
    if (upTo === "proof") return s;
    await s.verify();
    if (upTo === "verified") return s;
    await s.startGeneration();
    if (upTo === "generating") return s;
    await s.runSuccessfulJob();
    await s.markReadyForReview();
    if (upTo === "ready") return s;
    await s.release();
    return s;
  }
}
