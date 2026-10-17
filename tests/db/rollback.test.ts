import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./support/harness";

const ROOT = process.cwd();
const migrations = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();

describe("rollback scripts", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  it("has one rollback per migration", () => {
    const downs = readdirSync(path.join(ROOT, "supabase/rollbacks")).sort();
    expect(downs).toEqual(migrations.map((m) => m.replace(/\.sql$/, ".down.sql")));
  });

  it("removes every application table, then migrations re-apply cleanly", async () => {
    for (const m of [...migrations].reverse()) {
      const sql = readFileSync(path.join(ROOT, "supabase/rollbacks", m.replace(/\.sql$/, ".down.sql")), "utf8");
      await db.exec(sql);
    }
    const left = await db.query<{ n: string }>(
      "select count(*)::text as n from pg_tables where schemaname = 'public'",
    );
    expect(left.rows[0].n).toBe("0");
    const fns = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public','app_private')`,
    );
    expect(fns.rows[0].n).toBe("0");

    for (const m of migrations) {
      await db.exec(readFileSync(path.join(ROOT, "supabase/migrations", m), "utf8"));
    }
    const back = await db.query<{ n: string }>(
      "select count(*)::text as n from public.project_status_transitions",
    );
    expect(back.rows[0].n).toBe("24");
  });
});
