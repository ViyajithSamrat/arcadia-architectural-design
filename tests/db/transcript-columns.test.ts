import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createDatabase, createUser, expectError, service, superuser, user } from "./support/harness";

/**
 * R1-C (migration 20261021000100): customers cannot write source_language, transcript_original
 * or transcript_corrected, through grants (revoked) and a separate guard trigger (defence in
 * depth). Trusted server code (the service role) still can, on editable drafts.
 */
describe("transcript columns are written by trusted server code only", () => {
  let db: PGlite;
  let customer: string;

  beforeAll(async () => {
    db = await createDatabase();
    customer = await createUser(db, "transcript-customer");
  });
  afterAll(async () => {
    await db.close();
  });

  const newDraft = () =>
    as(db, user(customer), (q) =>
      q<{ id: string; source_language: string | null; transcript_original: string | null }>(
        "insert into public.projects (customer_id, project_type) values ($1, 'INTERIOR') returning id, source_language, transcript_original",
        [customer],
      ),
    ).then((rows) => rows[0]);

  /** Runs `sql` as the customer after a superuser grant inside the same transaction, then rolls everything back. */
  async function asCustomerWithExtraGrant(grant: string, sql: string, params: unknown[]): Promise<string | null> {
    await db.exec("begin");
    try {
      await db.exec(grant);
      await db.exec("set local role authenticated");
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [customer]);
      await db.query(sql, params);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await db.exec("rollback");
    }
  }

  it("a customer's new draft gets source_language 'en' from the database default and no transcript", async () => {
    expect(await newDraft()).toMatchObject({ source_language: "en", transcript_original: null });
  });

  it("a customer cannot insert a transcript or a language", async () => {
    await expectError(
      as(db, user(customer), (q) => q("insert into public.projects (customer_id, project_type, transcript_original) values ($1, 'INTERIOR', 'fake')", [customer])),
      /permission denied/,
    );
    await expectError(
      as(db, user(customer), (q) => q("insert into public.projects (customer_id, project_type, source_language) values ($1, 'INTERIOR', 'ta-IN')", [customer])),
      /permission denied/,
    );
  });

  it.each([
    ["transcript_original", "'typed but claimed as speech'"],
    ["transcript_corrected", "'edited'"],
    ["source_language", "'ta-IN'"],
  ])("a customer cannot update %s on their own draft", async (column, value) => {
    const { id } = await newDraft();
    await expectError(as(db, user(customer), (q) => q(`update public.projects set ${column} = ${value} where id = $1`, [id])), /permission denied/);
  });

  it("a customer can still edit their own draft's answers and brief text", async () => {
    const { id } = await newDraft();
    const rows = await as(db, user(customer), (q) =>
      q("update public.projects set requirements_json = '{\"schemaVersion\":1}'::jsonb, english_brief_text = null where id = $1 returning id", [id]),
    );
    expect(rows).toHaveLength(1);
  });

  it("the guard trigger refuses customer writes even if a broader grant were added (defence in depth)", async () => {
    const { id } = await newDraft();
    expect(await asCustomerWithExtraGrant("grant update (transcript_original) on public.projects to authenticated", "update public.projects set transcript_original = 'x' where id = $1", [id])).toMatch(
      /trusted server code/,
    );
    expect(await asCustomerWithExtraGrant("grant update (source_language) on public.projects to authenticated", "update public.projects set source_language = 'ta-IN' where id = $1", [id])).toMatch(
      /trusted server code/,
    );
    expect(
      await asCustomerWithExtraGrant(
        "grant insert (transcript_original) on public.projects to authenticated",
        "insert into public.projects (customer_id, project_type, transcript_original) values ($1, 'INTERIOR', 'x')",
        [customer],
      ),
    ).toMatch(/trusted server code/);
    // The grants above were rolled back with their transactions.
    const still = await as(db, superuser, (q) => q<{ ok: boolean }>("select has_column_privilege('authenticated', 'public.projects', 'transcript_original', 'UPDATE') as ok"));
    expect(still[0].ok).toBe(false);
  });

  it("the trusted server (service role) can save and clear the transcript on an editable draft", async () => {
    const { id } = await newDraft();
    const saved = await as(db, service, (q) =>
      q<{ transcript_original: string; source_language: string }>(
        "update public.projects set transcript_original = 'mock transcript', transcript_corrected = 'edited', source_language = 'en' where id = $1 and customer_id = $2 and status = 'DRAFT' returning transcript_original, source_language",
        [id, customer],
      ),
    );
    expect(saved).toEqual([{ transcript_original: "mock transcript", source_language: "en" }]);
    const cleared = await as(db, service, (q) =>
      q("update public.projects set transcript_original = null, transcript_corrected = null where id = $1 returning id", [id]),
    );
    expect(cleared).toHaveLength(1);
  });

  it("the guard function runs as the caller with an empty search_path", async () => {
    const rows = await as(db, superuser, (q) =>
      q<{ prosecdef: boolean; proconfig: string[] }>(
        "select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app_private' and p.proname = 'projects_transcript_guard'",
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prosecdef).toBe(false);
    expect(rows[0].proconfig).toContain('search_path=""');
  });

  it("the rollback restores the earlier grants and removes the default and trigger; re-applying restricts again", async () => {
    const root = process.cwd();
    const name = "20261021000100_restrict_transcript_columns";
    const privilege = async () =>
      (await as(db, superuser, (q) => q<{ ok: boolean }>("select has_column_privilege('authenticated', 'public.projects', 'transcript_original', 'UPDATE') as ok")))[0].ok;
    await db.exec(readFileSync(path.join(root, "supabase/rollbacks", `${name}.down.sql`), "utf8"));
    expect(await privilege()).toBe(true);
    const after = await as(db, superuser, (q) =>
      q<{ def: string | null; triggers: string }>(
        `select (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'source_language') as def,
                (select count(*)::text from pg_trigger where tgname = 'trg_15_projects_transcript_guard') as triggers`,
      ),
    );
    expect(after[0]).toEqual({ def: null, triggers: "0" });
    await db.exec(readFileSync(path.join(root, "supabase/migrations", `${name}.sql`), "utf8"));
    expect(await privilege()).toBe(false);
  });
});
