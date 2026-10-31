import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A tiny in-memory stand-in for the parts of the Supabase query builder that the
 * journey service uses. It applies filters the way PostgREST does (so a conditional
 * `eq("status", ...)` update that matches nothing changes nothing). It does NOT model
 * row level security or the database guards: those are covered by tests/db.
 */

type Row = Record<string, unknown>;
type Filter = { column: string; kind: "eq" | "is" | "in" | "notnull"; value: unknown };

export class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every write, in order, for assertions: `${table}.${insert|update}`. */
  writes: { op: string; table: string; payload: Row }[] = [];
  /** Make the next matching write fail, to test error handling. */
  failNext: { table: string; op: "insert" | "update" | "delete"; code?: string } | null = null;
  /** Handlers for `rpc(name, args)`; an unknown name returns an error. */
  rpcHandlers: Record<string, (args: Row) => { data?: unknown; error?: { code?: string; message: string } | null }> = {};
  rpcCalls: { name: string; args: Row }[] = [];
  /** Calls to the modelled insert_generated_asset; the Nth one (1-based) fails when `failAssetInsertAt` is N. */
  /** Keeps successive updated_at stamps distinct even inside one millisecond. */
  stampTick = 0;
  assetInsertCalls = 0;
  failAssetInsertAt: number | null = null;
  /** After that failed insert, make the next design_assets delete fail too (cleanup that cannot finish). */
  failDeleteAfterAssetFailure = false;
  /** Storage: objects by bucket/path, with a log of uploads, removals and signed links. */
  objects = new Map<string, Uint8Array>();
  uploads: { path: string; contentType?: string }[] = [];
  removals: string[] = [];
  signed: { path: string; seconds: number; download?: string | boolean }[] = [];
  failUpload = false;
  /** Runs once, just before the next storage removal. */
  beforeRemove: (() => Promise<void> | void) | null = null;
  /** Make every storage removal fail, to test cleanup that cannot finish. */
  failRemove = false;
  /** Make every storage listing fail. */
  failList = false;
  /** Column defaults the real database applies on insert, by table (for example a new job is QUEUED). */
  defaults: Record<string, Row> = {};

  seed(table: string, rows: Row[]) {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
    return this;
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  /**
   * A MODEL of public.insert_generated_asset for the service tests: the job must exist, belong to the
   * project and be RUNNING; the row is then written like any other insert (so `writes` and `failNext`
   * still apply). Payment and project status are not modelled. The real function, its locking and
   * its refusals are tested against PostgreSQL (tests/db/insert-generated-asset.test.ts and
   * tests/live/insert-generated-asset.live.test.ts).
   */
  private async insertGeneratedAsset(args: Row): Promise<{ data: unknown; error: { code?: string; message: string } | null }> {
    this.assetInsertCalls += 1;
    const failThis = this.failAssetInsertAt === this.assetInsertCalls;
    if (failThis) this.failNext = { table: "design_assets", op: "insert" };
    try {
      return await this.insertGeneratedAssetRow(args);
    } finally {
      if (failThis && this.failDeleteAfterAssetFailure) this.failNext = { table: "design_assets", op: "delete" };
    }
  }

  private async insertGeneratedAssetRow(args: Row): Promise<{ data: unknown; error: { code?: string; message: string } | null }> {
    const job = this.rows("generation_jobs").find((j) => j.id === args.p_job_id);
    if (!job || job.project_id !== args.p_project_id) return { data: null, error: { code: "23514", message: "the generation job belongs to a different project" } };
    if (job.status !== "RUNNING") return { data: null, error: { code: "23514", message: "generated assets can be added only to a running generation job" } };
    const result = await new Query(this, "design_assets")
      .insert({
        project_id: args.p_project_id,
        generation_job_id: args.p_job_id,
        asset_type: args.p_asset_type,
        storage_path: args.p_storage_path,
        mime_type: args.p_mime_type,
        width: args.p_width ?? null,
        height: args.p_height ?? null,
      })
      .select()
      .single();
    const row = result.data as Row | null;
    return { data: row ? row.id : null, error: (result.error as { code?: string; message: string } | null) ?? null };
  }

  /**
   * A MODEL of public.end_interrupted_generation (the checks and the move happen in one step here because
   * this fake is single-threaded). The row locking that makes the real function atomic against a job insert
   * is NOT modelled; it is proven against PostgreSQL (tests/live/serialize-stale-clearing.live.test.ts).
   */
  private async endInterruptedGeneration(args: Row): Promise<{ data: unknown; error: { code?: string; message: string } | null }> {
    const project = this.rows("projects").find((r) => r.id === args.p_project_id);
    if (!project) return { data: "NOT_FOUND", error: null };
    if (project.status !== "GENERATING" || (args.p_expect_updated_at != null && project.updated_at !== args.p_expect_updated_at)) return { data: "PROJECT_CHANGED", error: null };
    if (this.rows("generation_jobs").some((j) => j.project_id === args.p_project_id && (j.status === "QUEUED" || j.status === "RUNNING"))) return { data: "ACTIVE_JOB", error: null };
    const moved = await new Query(this, "projects").update({ status: "GENERATION_FAILED" }).eq("id", args.p_project_id).select();
    return moved.error ? { data: null, error: moved.error as { code?: string; message: string } } : { data: "MOVED", error: null };
  }

  client(): SupabaseClient {
    return {
      from: (table: string) => new Query(this, table),
      rpc: async (name: string, args: Row) => {
        this.rpcCalls.push({ name, args });
        const handler = this.rpcHandlers[name];
        if (!handler && name === "insert_generated_asset") return this.insertGeneratedAsset(args);
        if (!handler && name === "end_interrupted_generation") return this.endInterruptedGeneration(args);
        if (!handler) return { data: null, error: { message: "unknown function" } };
        const out = handler(args);
        return { data: out.data ?? null, error: out.error ?? null };
      },
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string, body: Uint8Array, options?: { contentType?: string }) => {
            if (this.failUpload) return { data: null, error: { message: "simulated upload failure" } };
            this.objects.set(`${bucket}/${path}`, body);
            this.uploads.push({ path, contentType: options?.contentType });
            return { data: { path }, error: null };
          },
          remove: async (paths: string[]) => {
            if (this.beforeRemove) {
              const hook = this.beforeRemove;
              this.beforeRemove = null;
              await hook(); // lets a test interleave another actor with a cleanup in progress
            }
            if (this.failRemove) return { data: null, error: { message: "simulated removal failure" } };
            for (const path of paths) {
              this.objects.delete(`${bucket}/${path}`);
              this.removals.push(path);
            }
            return { data: [], error: null };
          },
          list: async (folder: string) => {
            if (this.failList) return { data: null, error: { message: "simulated listing failure" } };
            const prefix = `${bucket}/${folder}/`;
            const data = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => ({ name: k.slice(prefix.length) }));
            return { data, error: null };
          },
          createSignedUrl: async (path: string, seconds: number, options?: { download?: string | boolean }) => {
            this.signed.push(options?.download === undefined ? { path, seconds } : { path, seconds, download: options.download });
            // Like Storage, a download link is the same signed link with a download parameter (the saved file name).
            const download = options?.download === undefined ? "" : `&download=${options.download === true ? "" : encodeURIComponent(String(options.download))}`;
            return { data: { signedUrl: `https://signed.test/${path}?t=${seconds}${download}` }, error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
  }
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row = {};
  private returning = false;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private max = Infinity;
  private mode: "many" | "maybe" | "single" = "many";

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select() {
    this.returning = true;
    return this;
  }
  insert(payload: Row) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  /** Only the `.not(column, "is", null)` form is supported. */
  not(column: string, operator: string, value: unknown) {
    if (operator !== "is" || value !== null) throw new Error("fake .not() supports only (column, 'is', null)");
    this.filters.push({ column, kind: "notnull", value: null });
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push({ column, kind: "eq", value });
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push({ column, kind: "is", value });
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push({ column, kind: "in", value: values });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending ?? true };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }

  private matches(row: Row) {
    return this.filters.every((f) =>
      f.kind === "is" ? (row[f.column] ?? null) === f.value : f.kind === "notnull" ? (row[f.column] ?? null) !== null : f.kind === "in" ? (f.value as unknown[]).includes(row[f.column]) : row[f.column] === f.value,
    );
  }

  private run(): { data: unknown; error: unknown } {
    const db = this.db;
    const rows = (db.tables[this.table] ??= []);
    const failure = { message: "simulated database failure", code: db.failNext?.code };

    if (this.op !== "select") {
      db.writes.push({ op: this.op, table: this.table, payload: this.payload });
      if (db.failNext && db.failNext.table === this.table && db.failNext.op === this.op) {
        db.failNext = null;
        return { data: null, error: failure };
      }
    }

    let affected: Row[];
    if (this.op === "insert") {
      const row = { id: randomUUID(), created_at: new Date().toISOString(), ...(db.defaults[this.table] ?? {}), ...this.payload };
      rows.push(row);
      affected = [row];
    } else if (this.op === "delete") {
      affected = rows.filter((r) => this.matches(r));
      db.tables[this.table] = rows.filter((r) => !affected.includes(r));
    } else if (this.op === "update") {
      affected = rows.filter((r) => this.matches(r));
      // The real database stamps updated_at on every change of a project (trigger trg_20_projects_updated_at).
      const stamp = this.table === "projects" && !("updated_at" in this.payload) && "updated_at" in (affected[0] ?? {}) ? { updated_at: new Date(Date.now() + ++db.stampTick).toISOString() } : {};
      for (const r of affected) Object.assign(r, this.payload, stamp);
    } else {
      affected = rows.filter((r) => this.matches(r));
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        affected = [...affected].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
      }
      affected = affected.slice(0, this.max);
    }

    if (this.op !== "select" && !this.returning) return { data: null, error: null };
    const copies = affected.map((r) => ({ ...r }));
    if (this.mode === "many") return { data: copies, error: null };
    if (this.mode === "maybe") return { data: copies[0] ?? null, error: null };
    return copies.length === 1 ? { data: copies[0], error: null } : { data: null, error: { message: "expected one row" } };
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}
