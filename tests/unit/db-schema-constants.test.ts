import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSET_TYPES,
  GENERATION_JOB_STATUSES,
  PAYMENT_STATUSES,
  PROJECT_STATUSES,
  PROJECT_STATUS_TRANSITIONS,
  PROJECT_TYPES,
  canTransition,
} from "@/lib/db/schema";

const core = readFileSync(join(process.cwd(), "supabase/migrations/20261017000200_core_tables.sql"), "utf8");

/** The values of the first `check (<column> in (...))` for a column. */
function checkValues(column: string): string[] {
  const match = new RegExp(`check \\(${column} in \\(([^)]*)\\)`).exec(core);
  if (!match) throw new Error(`no check constraint found for ${column}`);
  return [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

describe("application constants match the SQL migrations", () => {
  it("project types, statuses, payment, job and asset vocabularies", () => {
    expect([...PROJECT_TYPES].sort()).toEqual(checkValues("project_type").sort());
    expect([...PROJECT_STATUSES].sort()).toEqual(checkValues("status").sort());
    for (const s of [...PAYMENT_STATUSES, ...GENERATION_JOB_STATUSES, ...ASSET_TYPES]) {
      expect(core).toContain(`'${s}'`);
    }
  });

  it("status transitions equal the seeded project_status_transitions rows", () => {
    const block = core.slice(core.indexOf("insert into public.project_status_transitions"));
    const sqlPairs = [...block.slice(0, block.indexOf(";")).matchAll(/\('([A-Z_]+)',\s*'([A-Z_]+)'\)/g)].map(
      (m) => `${m[1]}>${m[2]}`,
    );
    const appPairs = Object.entries(PROJECT_STATUS_TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((to) => `${from}>${to}`),
    );
    expect(appPairs.sort()).toEqual(sqlPairs.sort());
    expect(sqlPairs).toHaveLength(24);
  });

  it("canTransition reflects the table", () => {
    expect(canTransition("PAYMENT_PROOF_SUBMITTED", "PAYMENT_VERIFIED")).toBe(true);
    expect(canTransition("AWAITING_PAYMENT", "GENERATING")).toBe(false);
    expect(canTransition("PAYMENT_VERIFIED", "CANCELLED")).toBe(false);
  });
});
