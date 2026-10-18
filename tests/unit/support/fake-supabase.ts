import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A tiny in-memory stand-in for the parts of the Supabase query builder that the
 * journey service uses. It applies filters the way PostgREST does (so a conditional
 * `eq("status", ...)` update that matches nothing changes nothing). It does NOT model
 * row level security or the database guards: those are covered by tests/db.
 */

type Row = Record<string, unknown>;
type Filter = { column: string; kind: "eq" | "is"; value: unknown };

export class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every write, in order, for assertions: `${table}.${insert|update}`. */
  writes: { op: string; table: string; payload: Row }[] = [];
  /** Make the next matching write fail, to test error handling. */
  failNext: { table: string; op: "insert" | "update" } | null = null;

  seed(table: string, rows: Row[]) {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
    return this;
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  client(): SupabaseClient {
    return { from: (table: string) => new Query(this, table) } as unknown as SupabaseClient;
  }
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" = "select";
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
  eq(column: string, value: unknown) {
    this.filters.push({ column, kind: "eq", value });
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push({ column, kind: "is", value });
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
    return this.filters.every((f) => (f.kind === "is" ? (row[f.column] ?? null) === f.value : row[f.column] === f.value));
  }

  private run(): { data: unknown; error: unknown } {
    const db = this.db;
    const rows = (db.tables[this.table] ??= []);
    const failure = { message: "simulated database failure" };

    if (this.op !== "select") {
      db.writes.push({ op: this.op, table: this.table, payload: this.payload });
      if (db.failNext && db.failNext.table === this.table && db.failNext.op === this.op) {
        db.failNext = null;
        return { data: null, error: failure };
      }
    }

    let affected: Row[];
    if (this.op === "insert") {
      const row = { id: randomUUID(), created_at: new Date().toISOString(), ...this.payload };
      rows.push(row);
      affected = [row];
    } else if (this.op === "update") {
      affected = rows.filter((r) => this.matches(r));
      for (const r of affected) Object.assign(r, this.payload);
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
