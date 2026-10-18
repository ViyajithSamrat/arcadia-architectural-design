import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "./support/harness";

const ROOT = process.cwd();
const FILE = "20261018000100_payment_proof_limits";
const read = (dir: string, name: string) => readFileSync(path.join(ROOT, dir, name), "utf8");

describe("payment proof upload limits (migration 6)", () => {
  let db: PGlite;
  const bucket = async () =>
    (await db.query<{ file_size_limit: string | null; allowed_mime_types: string[] | null }>("select file_size_limit::text, allowed_mime_types from storage.buckets where id = 'project-files'")).rows[0];

  beforeAll(async () => {
    db = await createDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  it("limits the bucket to 5 MiB of JPEG, PNG and WebP, the same numbers the application checks", async () => {
    expect(await bucket()).toEqual({ file_size_limit: "5242880", allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] });
  });

  it("does not make the bucket public", async () => {
    const row = await db.query<{ public: boolean }>("select public from storage.buckets where id = 'project-files'");
    expect(row.rows[0].public).toBe(false);
  });

  it("its rollback removes only the limits, and the migration can be applied again", async () => {
    await db.exec(read("supabase/rollbacks", `${FILE}.down.sql`));
    expect(await bucket()).toEqual({ file_size_limit: null, allowed_mime_types: null });
    const still = await db.query<{ public: boolean }>("select public from storage.buckets where id = 'project-files'");
    expect(still.rows[0].public).toBe(false);
    await db.exec(read("supabase/migrations", `${FILE}.sql`));
    expect((await bucket()).file_size_limit).toBe("5242880");
  });
});
