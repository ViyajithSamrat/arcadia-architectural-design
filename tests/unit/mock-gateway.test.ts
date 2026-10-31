import { beforeEach, describe, expect, it } from "vitest";
import { isMockGatewayEnabled, isMockGatewayReference, newMockReference, payWithMockGateway } from "@/lib/payments/mock-gateway";
import { submitPayment } from "@/lib/payments/service";
import { FakeDb } from "./support/fake-supabase";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const QUOTE = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-27T12:00:00Z");
const ENV = { PAYMENT_MODE: "manual", PAYMENT_UPI_ID: "demo@demo", PAYMENT_INSTRUCTIONS: "DEMO — DO NOT TRANSFER MONEY.", PAYMENT_MOCK_GATEWAY: "true" };

const project = (patch: Record<string, unknown> = {}) => ({
  id: PROJECT, customer_id: ME, project_type: "INTERIOR", status: "AWAITING_PAYMENT",
  requirements_json: {}, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...patch,
});
const quote = (patch: Record<string, unknown> = {}) => ({
  id: QUOTE, project_id: PROJECT, currency: "INR", line_items_json: [], subtotal: 10000, tax_amount: 0, discount_amount: 0,
  total_amount: 12500, pricing_rule_version: "v1", valid_until: null, accepted_at: "2026-10-27T09:00:00Z", created_at: "2026-10-27T08:00:00Z", ...patch,
});

let userDb: FakeDb;
let serviceDb: FakeDb;
const pay = (user = ME, env: Record<string, string | undefined> = ENV) =>
  payWithMockGateway(userDb.client(), serviceDb.client(), user, PROJECT, { now: NOW, env, newReference: () => "MOCKPAY-ABCDEF123456" });
const inserts = () => userDb.writes.filter((w) => w.op === "insert");

beforeEach(() => {
  userDb = new FakeDb().seed("projects", [project()]).seed("quotes", [quote()]);
  serviceDb = new FakeDb();
});

describe("the simulated payment gateway", () => {
  it("is off unless PAYMENT_MOCK_GATEWAY is exactly true", () => {
    expect(isMockGatewayEnabled({})).toBe(false);
    expect(isMockGatewayEnabled({ PAYMENT_MOCK_GATEWAY: "1" })).toBe(false);
    expect(isMockGatewayEnabled({ PAYMENT_MOCK_GATEWAY: " TRUE " })).toBe(true);
  });

  it("success records only a PENDING claim for the server-side quote total, with a server-made reference", async () => {
    const result = await pay();
    expect(result).toMatchObject({ ok: true, reference: "MOCKPAY-ABCDEF123456" });
    expect(inserts()).toHaveLength(1);
    const row = inserts()[0].payload as Record<string, unknown>;
    expect(row).toMatchObject({ project_id: PROJECT, quote_id: QUOTE, amount_claimed: "12500.00", currency: "INR", utr_reference: "MOCKPAY-ABCDEF123456", transfer_date: "2026-10-27", proof_storage_path: null });
    // no status, verification, owner or decision is written: an administrator still decides
    for (const key of ["status", "verified_at", "verified_by", "confirmed_amount", "customer_id"]) expect(row).not.toHaveProperty(key);
    // the project status is never changed by the gateway
    expect(userDb.writes.filter((w) => w.table === "projects")).toHaveLength(0);
  });

  it("does nothing when switched off", async () => {
    const env: Record<string, string | undefined> = { ...ENV, PAYMENT_MOCK_GATEWAY: undefined };
    expect(await pay(ME, env)).toMatchObject({ ok: false });
    expect(inserts()).toHaveLength(0);
  });

  it("refuses another customer's project and a project without an accepted quote", async () => {
    expect(await pay(OTHER)).toMatchObject({ ok: false, message: "We could not find that project." });
    userDb = new FakeDb().seed("projects", [project()]).seed("quotes", [quote({ accepted_at: null })]);
    expect(await pay()).toMatchObject({ ok: false });
    expect(inserts()).toHaveLength(0);
  });

  it.each(["QUOTED", "PAYMENT_PROOF_SUBMITTED", "PAYMENT_VERIFIED", "RELEASED"])("refuses a project in %s", async (status) => {
    userDb = new FakeDb().seed("projects", [project({ status })]).seed("quotes", [quote()]);
    expect(await pay()).toMatchObject({ ok: false });
    expect(inserts()).toHaveLength(0);
  });

  it("needs the manual payment instructions to be configured", async () => {
    expect(await pay(ME, { PAYMENT_MOCK_GATEWAY: "true" })).toMatchObject({ ok: false });
    expect(inserts()).toHaveLength(0);
  });

  it("reserves MOCKPAY- references: a typed claim cannot use one", async () => {
    const typed = await submitPayment(userDb.client(), serviceDb.client(), ME, PROJECT, { utrReference: "mockpay-123456", transferDate: "2026-10-27", amount: "12500.00", method: "UPI", file: null }, { now: NOW, env: ENV });
    expect(typed).toMatchObject({ ok: false, fieldErrors: { utrReference: expect.any(String) } });
    expect(inserts()).toHaveLength(0);
  });

  it("makes references that fit the reference rules and are recognised as simulated", () => {
    const ref = newMockReference();
    expect(ref).toMatch(/^MOCKPAY-[0-9A-F]{12}$/);
    expect(isMockGatewayReference(ref)).toBe(true);
    expect(isMockGatewayReference("UTR123456789")).toBe(false);
  });
});
