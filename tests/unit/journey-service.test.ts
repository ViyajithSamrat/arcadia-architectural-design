import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockBriefProvider, type BriefProvider } from "@/lib/journeys/brief";
import { QUOTE_LINES, TAX_RULE_KEY } from "@/lib/journeys/quote";
import {
  acceptQuote,
  createBrief,
  createDraftProject,
  createQuote,
  getOwnedProject,
  reviewBrief,
  saveStep,
} from "@/lib/journeys/service";
import { FakeDb } from "./support/fake-supabase";
import { REQUIREMENTS, storedRequirements } from "./support/journey-fixtures";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

function project(patch: Record<string, unknown> = {}) {
  return {
    id: PROJECT,
    customer_id: ME,
    project_type: "EMPTY_PLOT",
    status: "DRAFT",
    source_language: "en",
    requirements_json: storedRequirements("EMPTY_PLOT"),
    english_brief_json: null,
    english_brief_text: null,
    approved_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

/** Rate 10 on every EMPTY_PLOT line plus 10% tax, in the fake currency XTS. */
function pricingRows() {
  const base = { project_type: "EMPTY_PLOT", unit: "unit", minimum_charge: 0, included_quantity: 0, add_on_rate: 0, currency: "XTS", effective_from: "2026-01-01T00:00:00Z", effective_until: null, version: 1, is_active: true };
  return [...QUOTE_LINES.EMPTY_PLOT.map((l) => l.key), TAX_RULE_KEY].map((key) => ({
    ...base,
    id: `rule-${key}`,
    rule_key: key,
    rate: 10,
    ...(key === TAX_RULE_KEY ? { unit: "percent" } : {}),
  }));
}

let userDb: FakeDb;
let serviceDb: FakeDb;
const user = () => userDb.client();
const service = () => serviceDb.client();

/** Two views of one database: what the user's session sees, and what the trusted client sees. */
beforeEach(() => {
  userDb = new FakeDb();
  serviceDb = new FakeDb();
  serviceDb.tables = userDb.tables; // same data, separate write logs
});

const status = () => userDb.rows("projects")[0].status;

describe("ownership", () => {
  it("returns nothing for someone else's project, even if the database shows it (admin read access)", async () => {
    userDb.seed("projects", [project({ customer_id: OTHER })]);
    expect(await getOwnedProject(user(), ME, PROJECT)).toBeNull();
  });

  it("returns nothing for a malformed id", async () => {
    userDb.seed("projects", [project()]);
    expect(await getOwnedProject(user(), ME, "../1; drop table projects")).toBeNull();
  });

  it("refuses every mutation on someone else's project", async () => {
    userDb.seed("projects", [project({ customer_id: OTHER })]);
    const results = [
      await saveStep(user(), ME, PROJECT, "space", REQUIREMENTS.EMPTY_PLOT.space),
      await createBrief(user(), service(), ME, PROJECT, mockBriefProvider),
      await reviewBrief(user(), service(), ME, PROJECT, "approve", "text", true),
      await createQuote(user(), service(), ME, PROJECT),
      await acceptQuote(user(), service(), ME, PROJECT, PROJECT),
    ];
    for (const r of results) expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/could not find/i) });
    expect(userDb.writes).toEqual([]);
    expect(serviceDb.writes).toEqual([]);
  });
});

describe("starting and answering", () => {
  it("creates a DRAFT owned by the signed-in user", async () => {
    const result = await createDraftProject(user(), ME, "INTERIOR");
    expect(result.ok).toBe(true);
    expect(userDb.writes[0].payload).toMatchObject({ customer_id: ME, project_type: "INTERIOR" });
    expect(userDb.writes[0].payload).not.toHaveProperty("status");
    // R1-C: customers may not write the language (or transcript) columns; the database default applies.
    expect(userDb.writes[0].payload).not.toHaveProperty("source_language");
    expect(userDb.writes[0].payload).not.toHaveProperty("transcript_original");
  });

  it("saves a valid step and points to the next one", async () => {
    userDb.seed("projects", [project({ requirements_json: { schemaVersion: 1 } })]);
    const result = await saveStep(user(), ME, PROJECT, "space", REQUIREMENTS.EMPTY_PLOT.space);
    expect(result).toEqual({ ok: true, nextStepId: "rooms" });
    expect((userDb.rows("projects")[0].requirements_json as Record<string, unknown>).space).toMatchObject({ plotWidth: 30 });
  });

  it("returns field errors and writes nothing for an invalid step", async () => {
    userDb.seed("projects", [project()]);
    const result = await saveStep(user(), ME, PROJECT, "space", { ...REQUIREMENTS.EMPTY_PLOT.space, plotWidth: -1 });
    expect(result).toMatchObject({ ok: false, fieldErrors: { plotWidth: expect.any(String) } });
    expect(userDb.writes).toEqual([]);
  });

  it("rejects an unknown step and a forged field", async () => {
    userDb.seed("projects", [project()]);
    expect(await saveStep(user(), ME, PROJECT, "payment", {})).toMatchObject({ ok: false });
    expect(await saveStep(user(), ME, PROJECT, "space", { ...REQUIREMENTS.EMPTY_PLOT.space, status: "RELEASED" })).toMatchObject({ ok: false });
  });

  it("refuses to edit once the brief is approved", async () => {
    userDb.seed("projects", [project({ status: "BRIEF_APPROVED" })]);
    expect(await saveStep(user(), ME, PROJECT, "space", REQUIREMENTS.EMPTY_PLOT.space)).toMatchObject({ ok: false });
    expect(userDb.writes).toEqual([]);
  });

  it("clears an existing brief when an answer changes", async () => {
    userDb.seed("projects", [project({ status: "BRIEF_REVIEW", english_brief_json: { stale: true }, english_brief_text: "old" })]);
    const result = await saveStep(user(), ME, PROJECT, "space", REQUIREMENTS.EMPTY_PLOT.space);
    expect(result.ok).toBe(true);
    expect(userDb.rows("projects")[0]).toMatchObject({ english_brief_json: null, english_brief_text: null, status: "BRIEF_REVIEW" });
  });

  it("never lets a customer-supplied step payload change status or owner", async () => {
    userDb.seed("projects", [project()]);
    await saveStep(user(), ME, PROJECT, "space", REQUIREMENTS.EMPTY_PLOT.space);
    const patch = userDb.writes.at(-1)!.payload;
    expect(Object.keys(patch)).toEqual(["requirements_json"]);
  });
});

describe("creating the brief", () => {
  it("does not call the provider when required answers are missing, and lists them", async () => {
    userDb.seed("projects", [project({ requirements_json: { schemaVersion: 1 } })]);
    const generate = vi.fn();
    const result = await createBrief(user(), service(), ME, PROJECT, { id: "mock", generate });
    expect(result).toMatchObject({ ok: false, missing: expect.arrayContaining([expect.stringMatching(/Plot width/)]) });
    expect(generate).not.toHaveBeenCalled();
    expect(serviceDb.writes).toEqual([]);
  });

  it("stores a valid brief and moves DRAFT to BRIEF_REVIEW", async () => {
    userDb.seed("projects", [project()]);
    expect(await createBrief(user(), service(), ME, PROJECT, mockBriefProvider)).toEqual({ ok: true });
    const row = userDb.rows("projects")[0];
    expect(row.status).toBe("BRIEF_REVIEW");
    expect(row.english_brief_text).toEqual(expect.stringContaining("30 × 40 ft"));
    expect((row.english_brief_json as { meta: { provider: string } }).meta.provider).toBe("mock");
  });

  it("rejects malformed provider output and stores nothing", async () => {
    userDb.seed("projects", [project()]);
    const bad: BriefProvider = { id: "mock", generate: async () => ({ englishBrief: "Looks fine!", price: 1 }) };
    const result = await createBrief(user(), service(), ME, PROJECT, bad);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/unexpected form/i) });
    expect(serviceDb.writes).toEqual([]);
    expect(status()).toBe("DRAFT");
  });

  it("survives a provider that throws, without leaking its message", async () => {
    userDb.seed("projects", [project()]);
    const boom: BriefProvider = { id: "mock", generate: async () => { throw new Error("secret key sk-123 rejected"); } };
    const result = await createBrief(user(), service(), ME, PROJECT, boom);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-123");
  });

  it("does not let the producer declare that nothing is missing or change the answers used", async () => {
    userDb.seed("projects", [project()]);
    const sneaky: BriefProvider = {
      id: "mock",
      generate: async (input) => {
        const brief = (await mockBriefProvider.generate(input)) as Record<string, unknown>;
        return { ...brief, requirements: { space: { plotWidth: 1 } }, missingRequiredFields: ["x"], projectType: "LANDSCAPE" };
      },
    };
    await createBrief(user(), service(), ME, PROJECT, sneaky);
    const stored = userDb.rows("projects")[0].english_brief_json as Record<string, unknown>;
    expect(stored.projectType).toBe("EMPTY_PLOT");
    expect(stored.missingRequiredFields).toEqual([]);
    expect((stored.requirements as { space: { plotWidth: number } }).space.plotWidth).toBe(30);
  });

  it("reports the live provider as unavailable instead of using the mock", async () => {
    userDb.seed("projects", [project()]);
    vi.stubEnv("PROVIDER_MODE", "live");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("OPENROUTER_TEXT_MODEL", "");
    const result = await createBrief(user(), service(), ME, PROJECT);
    vi.unstubAllEnvs();
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/not available/i) });
    expect(status()).toBe("DRAFT");
  });
});

describe("reviewing and approving the brief", () => {
  async function inReview() {
    userDb.seed("projects", [project()]);
    await createBrief(user(), service(), ME, PROJECT, mockBriefProvider);
    userDb.writes.length = 0;
    serviceDb.writes.length = 0;
  }

  it("saves edits without approving", async () => {
    await inReview();
    expect(await reviewBrief(user(), service(), ME, PROJECT, "save", "My edited brief", false)).toEqual({ ok: true });
    expect(userDb.rows("projects")[0]).toMatchObject({ english_brief_text: "My edited brief", status: "BRIEF_REVIEW", approved_at: null });
  });

  it("refuses to approve without the customer's confirmation", async () => {
    await inReview();
    const result = await reviewBrief(user(), service(), ME, PROJECT, "approve", "Fine brief", false);
    expect(result).toMatchObject({ ok: false, fieldErrors: { confirm: expect.any(String) } });
    expect(status()).toBe("BRIEF_REVIEW");
  });

  it("refuses an empty brief", async () => {
    await inReview();
    expect(await reviewBrief(user(), service(), ME, PROJECT, "approve", "   ", true)).toMatchObject({ ok: false, fieldErrors: { briefText: expect.any(String) } });
    expect(status()).toBe("BRIEF_REVIEW");
  });

  it("refuses approval when required answers are no longer complete", async () => {
    await inReview();
    userDb.rows("projects")[0].requirements_json = { schemaVersion: 1 };
    const result = await reviewBrief(user(), service(), ME, PROJECT, "approve", "Fine brief", true);
    expect(result).toMatchObject({ ok: false, missing: expect.any(Array) });
    expect(status()).toBe("BRIEF_REVIEW");
  });

  it("refuses when there is no readable brief", async () => {
    userDb.seed("projects", [project({ status: "BRIEF_REVIEW" })]);
    expect(await reviewBrief(user(), service(), ME, PROJECT, "approve", "Text", true)).toMatchObject({ ok: false });
    expect(status()).toBe("BRIEF_REVIEW");
  });

  it("approves with confirmation, using the trusted client for the status change only", async () => {
    await inReview();
    expect(await reviewBrief(user(), service(), ME, PROJECT, "approve", "Approved text", true)).toEqual({ ok: true });
    expect(status()).toBe("BRIEF_APPROVED");
    expect(serviceDb.writes.map((w) => w.payload)).toEqual([{ status: "BRIEF_APPROVED" }]);
  });

  it("cannot approve a project that is not in review", async () => {
    userDb.seed("projects", [project({ status: "QUOTED" })]);
    expect(await reviewBrief(user(), service(), ME, PROJECT, "approve", "Text", true)).toMatchObject({ ok: false });
    expect(status()).toBe("QUOTED");
  });
});

describe("quote preparation", () => {
  function approved() {
    userDb.seed("projects", [project({ status: "BRIEF_APPROVED", english_brief_text: "Approved" })]);
  }

  it("refuses with 'Pricing not configured' when no rates exist, creating nothing", async () => {
    approved();
    const result = await createQuote(user(), service(), ME, PROJECT);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/Pricing not configured/) });
    expect(userDb.rows("quotes")).toHaveLength(0);
    expect(status()).toBe("BRIEF_APPROVED");
  });

  it("refuses when a needed rate is missing", async () => {
    approved();
    userDb.seed("pricing_rules", pricingRows().filter((r) => r.rule_key !== "layout_per_floor"));
    expect(await createQuote(user(), service(), ME, PROJECT)).toMatchObject({ ok: false, message: expect.stringMatching(/Pricing not configured/) });
    expect(userDb.rows("quotes")).toHaveLength(0);
  });

  it("refuses before the brief is approved", async () => {
    userDb.seed("projects", [project({ status: "BRIEF_REVIEW" })]);
    userDb.seed("pricing_rules", pricingRows());
    expect(await createQuote(user(), service(), ME, PROJECT)).toMatchObject({ ok: false });
    expect(userDb.rows("quotes")).toHaveLength(0);
  });

  it("saves a server-calculated quote and moves to QUOTED", async () => {
    approved();
    userDb.seed("pricing_rules", pricingRows());
    expect(await createQuote(user(), service(), ME, PROJECT)).toEqual({ ok: true });
    const quote = userDb.rows("quotes")[0];
    expect(quote).toMatchObject({ project_id: PROJECT, currency: "XTS", subtotal: "100.00", tax_amount: "10.00", discount_amount: "0.00", total_amount: "110.00" });
    expect(String(quote.pricing_rule_version)).toContain("base_fee@1");
    expect(String(quote.pricing_rule_version).startsWith("DEMO:")).toBe(false);
    expect(status()).toBe("QUOTED");
  });

  it("marks the quote as demo when the pricing mode says so", async () => {
    approved();
    userDb.seed("pricing_rules", pricingRows());
    userDb.seed("site_settings", [{ key: "pricing_mode", value_json: { mode: "demo" } }]);
    await createQuote(user(), service(), ME, PROJECT);
    expect(String(userDb.rows("quotes")[0].pricing_rule_version).startsWith("DEMO:")).toBe(true);
  });

  it("takes no total, rate or line from the caller", async () => {
    approved();
    userDb.seed("pricing_rules", pricingRows());
    // The only inputs are ids; there is nothing to forge. A forged extra argument is ignored.
    await (createQuote as (...a: unknown[]) => Promise<unknown>)(user(), service(), ME, PROJECT, { total: 1 });
    expect(userDb.rows("quotes")[0].total_amount).toBe("110.00");
  });

  it("lets a stale second request fail without a second status change", async () => {
    approved();
    userDb.seed("pricing_rules", pricingRows());
    userDb.rows("projects")[0].status = "QUOTED"; // another tab already moved it
    expect(await createQuote(user(), service(), ME, PROJECT)).toEqual({ ok: true });
    expect(userDb.rows("quotes")).toHaveLength(0);
  });
});

describe("accepting the quote", () => {
  async function quoted() {
    userDb.seed("projects", [project({ status: "BRIEF_APPROVED", english_brief_text: "Approved" })]);
    userDb.seed("pricing_rules", pricingRows());
    await createQuote(user(), service(), ME, PROJECT);
    userDb.writes.length = 0;
    serviceDb.writes.length = 0;
    return String(userDb.rows("quotes")[0].id);
  }

  it("accepts the quote the customer saw and moves to AWAITING_PAYMENT", async () => {
    const quoteId = await quoted();
    expect(await acceptQuote(user(), service(), ME, PROJECT, quoteId)).toEqual({ ok: true });
    expect(userDb.rows("quotes")[0].accepted_at).toBeTruthy();
    expect(status()).toBe("AWAITING_PAYMENT");
  });

  it("refuses a quote id that is not the current quote", async () => {
    await quoted();
    const result = await acceptQuote(user(), service(), ME, PROJECT, "44444444-4444-4444-8444-444444444444");
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/out of date/i) });
    expect(status()).toBe("QUOTED");
  });

  it("refuses an expired quote", async () => {
    const quoteId = await quoted();
    userDb.rows("quotes")[0].valid_until = "2020-01-01T00:00:00Z";
    expect(await acceptQuote(user(), service(), ME, PROJECT, quoteId)).toMatchObject({ ok: false, message: expect.stringMatching(/expired/i) });
    expect(status()).toBe("QUOTED");
  });

  it("refuses when the project is not at the quoted stage", async () => {
    const quoteId = await quoted();
    userDb.rows("projects")[0].status = "BRIEF_APPROVED";
    expect(await acceptQuote(user(), service(), ME, PROJECT, quoteId)).toMatchObject({ ok: false });
    expect(userDb.rows("quotes")[0].accepted_at ?? null).toBeNull();
  });

  it("finishes the move if an earlier attempt accepted the quote but stopped before the status change", async () => {
    const quoteId = await quoted();
    userDb.rows("quotes")[0].accepted_at = "2026-02-01T00:00:00Z";
    expect(await acceptQuote(user(), service(), ME, PROJECT, quoteId)).toEqual({ ok: true });
    expect(status()).toBe("AWAITING_PAYMENT");
  });

  it("reports a failed write as a generic error", async () => {
    const quoteId = await quoted();
    serviceDb.failNext = { table: "quotes", op: "update" };
    userDb.failNext = serviceDb.failNext;
    const result = await acceptQuote(user(), service(), ME, PROJECT, quoteId);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/try again/i) });
    expect(status()).toBe("QUOTED");
  });

  it("never goes beyond AWAITING_PAYMENT: no payment or generation states are touched", async () => {
    const quoteId = await quoted();
    await acceptQuote(user(), service(), ME, PROJECT, quoteId);
    const statuses = [...userDb.writes, ...serviceDb.writes].map((w) => w.payload.status).filter(Boolean);
    expect(statuses).toEqual(["AWAITING_PAYMENT"]);
  });
});
