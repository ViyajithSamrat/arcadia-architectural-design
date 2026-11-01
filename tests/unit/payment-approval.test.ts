import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countPendingPayments, parseConfirmedAmount, verifyPayment } from "@/lib/payments/service";
import { FakeDb } from "./support/fake-supabase";

/**
 * The administrator's payment approval, end to end above the database: the amount the
 * administrator types, the Server Actions (role check, decision, refresh, redirect) and the
 * pointer from My projects to the payment queue.
 *
 * Reported 2026-10-31: an administrator could not get a customer's payment approved. The database
 * side worked (an approval at 11:04 IST that day verified and later released). After the 19:33 IST
 * simulated payment no approval request reached the database: the administrator was on My
 * projects, which lists only the account's own projects (one Draft) and gave no sign of the
 * payment queue. A second defect would have stopped them on the review page itself: it shows the
 * quoted total as "₹7,611.00", and that exact text, or "7,611.00", was refused as "Enter the
 * amount received".
 */

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url), usePathname: () => "/projects" }));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

// A verification schedules the generation that follows it (src/lib/generation/auto.ts) with after();
// outside a request that call is an error, so it is captured here and never run in these tests.
const scheduled: (() => unknown)[] = [];
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<object>()), after: (fn: () => unknown) => scheduled.push(fn) }));

const createServerClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => createServerClient() }));

const getPageAccess = vi.fn();
vi.mock("@/lib/journeys/access", () => ({ getPageAccess: () => getPageAccess() }));

const listOwnProjects = vi.fn();
vi.mock("@/lib/journeys/service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listOwnProjects: (...a: unknown[]) => listOwnProjects(...a),
}));

const actions = await import("@/app/(app)/admin/payments/actions");
const { default: ProjectsPage } = await import("@/app/(app)/projects/page");

const PAYMENT = "55555555-5555-4555-8555-555555555555";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const QUOTE = "44444444-4444-4444-8444-444444444444";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";

/** A pending claim against a quote of ₹7,611.00, as the reported payment was. */
const pending = () => ({ id: PAYMENT, project_id: PROJECT, quote_id: QUOTE, status: "PENDING_REVIEW", quotes: { total_amount: "7611.00" }, created_at: "2026-10-31T14:03:42Z" });

/** The database functions as the migrations define them: one decision per pending payment, administrators only. */
function paymentDb(isAdmin: boolean): FakeDb {
  const db = new FakeDb().seed("payments", [pending()]);
  db.rpcHandlers.is_admin = () => ({ data: isAdmin });
  const decide = (status: "VERIFIED" | "REJECTED") => () => {
    if (!isAdmin) return { error: { code: "42501", message: "administrator access required" } };
    const row = db.tables.payments.find((p) => p.id === PAYMENT);
    if (!row || row.status !== "PENDING_REVIEW") return { error: { code: "P0002", message: "payment not found or not awaiting review" } };
    row.status = status;
    return { data: row };
  };
  db.rpcHandlers.admin_verify_payment = decide("VERIFIED");
  db.rpcHandlers.admin_reject_payment = decide("REJECTED");
  return db;
}

/** The session client the Server Actions receive: the fake database plus the Auth check. */
function sessionFor(db: FakeDb, userId: string | null) {
  return {
    ...db.client(),
    auth: { getUser: async () => (userId ? { data: { user: { id: userId } }, error: null } : { data: { user: null }, error: { message: "no session" } }) },
  };
}

const decisionCalls = (db: FakeDb) => db.rpcCalls.filter((c) => c.name.startsWith("admin_"));
const statusOf = (db: FakeDb) => db.tables.payments.find((p) => p.id === PAYMENT)?.status;

beforeEach(() => {
  vi.clearAllMocks();
  scheduled.length = 0;
  redirect.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  });
});

describe("the amount an administrator confirms", () => {
  it.each([
    ["7611", 761100],
    ["7611.00", 761100],
    ["7,611", 761100],
    ["7,611.00", 761100],
    ["₹7,611.00", 761100],
    ["₹ 7,611", 761100],
    ["  ₹7,611.00  ", 761100],
    ["INR 7,611.00", 761100],
    ["Rs. 7,611", 761100],
    ["rs 7611.5", 761150],
    ["12,500.00", 1250000],
    ["1,02,660.00", 10266000],
    ["12,34,567", 123456700],
  ])("accepts %j as %i minor units", (input, minor) => {
    expect(parseConfirmedAmount(input)).toBe(minor);
  });

  it.each(["", "   ", "₹", "abc", "0", "₹0.00", "-7611", "+7611", "1e3", "7611.", ".5", "7611.001", "7.611,00", "7,61,1", "76,11", "7,611,", ",7611", "7611 INR", "$7,611", "99999999999"])(
    "refuses %j",
    (input) => {
      expect(parseConfirmedAmount(input)).toBeNull();
    },
  );
});

describe("verifyPayment with the amount as the review page shows it (the reported defect)", () => {
  it("verifies when the administrator types ₹7,611.00, and sends the plain decimal to the database", async () => {
    const db = paymentDb(true);
    expect(await verifyPayment(db.client(), PAYMENT, { confirmedAmount: "₹7,611.00", note: "", acknowledged: true })).toEqual({ ok: true, projectId: PROJECT });
    expect(decisionCalls(db)).toEqual([{ name: "admin_verify_payment", args: { p_payment_id: PAYMENT, p_confirmed_amount: "7611.00", p_audit_note: null } }]);
  });

  it("still refuses an amount that differs from the quote, however it is written, without calling the database", async () => {
    for (const amount of ["₹7,610.00", "7,612", "76,110.00"]) {
      const db = paymentDb(true);
      expect(await verifyPayment(db.client(), PAYMENT, { confirmedAmount: amount, note: "", acknowledged: true })).toMatchObject({ ok: false, message: expect.stringContaining("must equal the full quoted total") });
      expect(decisionCalls(db)).toHaveLength(0);
    }
  });

  it("explains the accepted forms when the amount cannot be read", async () => {
    const db = paymentDb(true);
    const result = await verifyPayment(db.client(), PAYMENT, { confirmedAmount: "seven thousand", note: "", acknowledged: true });
    expect(result).toMatchObject({ ok: false, message: "Enter the amount received, for example 12500.00 or ₹12,500.00.", fieldErrors: { confirmedAmount: "Enter the amount received." } });
    expect(decisionCalls(db)).toHaveLength(0);
  });
});

describe("the payment decision Server Actions", () => {
  it("approval: an administrator's decision is recorded, the whole admin area is refreshed, and the page shows the result", async () => {
    const db = paymentDb(true);
    createServerClient.mockResolvedValue(sessionFor(db, ADMIN));
    await expect(actions.verifyPaymentAction(PAYMENT, "₹7,611.00", "Seen in the statement.", true)).rejects.toThrow(`NEXT_REDIRECT:/admin/payments/${PAYMENT}?decided=1`);
    expect(statusOf(db)).toBe("VERIFIED");
    expect(decisionCalls(db)).toEqual([{ name: "admin_verify_payment", args: { p_payment_id: PAYMENT, p_confirmed_amount: "7611.00", p_audit_note: "Seen in the statement." } }]);
    // "/admin" as a layout covers the overview's pending count, the queue and this payment's page.
    expect(revalidatePath).toHaveBeenCalledWith("/admin", "layout");
    // The verification owes the customer a generation: one run is scheduled, to start after the response.
    expect(scheduled).toHaveLength(1);
  });

  it("rejection: recorded with its reason, refreshed and shown the same way", async () => {
    const db = paymentDb(true);
    createServerClient.mockResolvedValue(sessionFor(db, ADMIN));
    await expect(actions.rejectPaymentAction(PAYMENT, "No matching credit found.", "")).rejects.toThrow(`NEXT_REDIRECT:/admin/payments/${PAYMENT}?decided=1`);
    expect(statusOf(db)).toBe("REJECTED");
    expect(decisionCalls(db)).toEqual([{ name: "admin_reject_payment", args: { p_payment_id: PAYMENT, p_reason: "No matching credit found.", p_audit_note: null } }]);
    expect(revalidatePath).toHaveBeenCalledWith("/admin", "layout");
  });

  it("a customer cannot approve or reject: refused before any decision, nothing refreshed", async () => {
    const db = paymentDb(false);
    createServerClient.mockResolvedValue(sessionFor(db, CUSTOMER));
    expect(await actions.verifyPaymentAction(PAYMENT, "7611.00", "", true)).toEqual({ ok: false, message: "You do not have access to this area." });
    expect(await actions.rejectPaymentAction(PAYMENT, "No credit seen.", "")).toEqual({ ok: false, message: "You do not have access to this area." });
    expect(decisionCalls(db)).toHaveLength(0);
    expect(statusOf(db)).toBe("PENDING_REVIEW");
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("a signed-out request is refused the same way", async () => {
    const db = paymentDb(true);
    createServerClient.mockResolvedValue(sessionFor(db, null));
    expect(await actions.verifyPaymentAction(PAYMENT, "7611.00", "", true)).toEqual({ ok: false, message: "Please sign in to continue." });
    expect(decisionCalls(db)).toHaveLength(0);
    expect(statusOf(db)).toBe("PENDING_REVIEW");
  });

  it("a duplicate approval (double click, second tab) records nothing new and says the payment is already decided", async () => {
    const db = paymentDb(true);
    createServerClient.mockResolvedValue(sessionFor(db, ADMIN));
    await expect(actions.verifyPaymentAction(PAYMENT, "7611.00", "", true)).rejects.toThrow("NEXT_REDIRECT");
    vi.clearAllMocks();
    const second = await actions.verifyPaymentAction(PAYMENT, "7611.00", "", true);
    expect(second).toMatchObject({ ok: false, message: expect.stringContaining("already been decided") });
    const reject = await actions.rejectPaymentAction(PAYMENT, "Changed my mind.", "");
    expect(reject).toMatchObject({ ok: false, message: expect.stringContaining("already been decided") });
    expect(decisionCalls(db).map((c) => c.name)).toEqual(["admin_verify_payment", "admin_reject_payment"]);
    expect(statusOf(db)).toBe("VERIFIED");
    expect(revalidatePath).not.toHaveBeenCalled();
    // Only the first approval scheduled a generation; the repeats and the rejection scheduled none.
    expect(scheduled).toHaveLength(1);
  });

  it("refuses malformed arguments before reading anything", async () => {
    const db = paymentDb(true);
    createServerClient.mockResolvedValue(sessionFor(db, ADMIN));
    expect(await actions.verifyPaymentAction("../x", "7611.00", "", true)).toEqual({ ok: false, message: "That request was not valid." });
    expect(await actions.rejectPaymentAction(PAYMENT, 5 as never, "")).toEqual({ ok: false, message: "That request was not valid." });
    expect(createServerClient).not.toHaveBeenCalled();
  });
});

describe("countPendingPayments", () => {
  function counting(result: { count: number | null; error: { message: string } | null }) {
    const seen: { select?: unknown[]; eq?: unknown[] } = {};
    const client = {
      from: (table: string) => {
        expect(table).toBe("payments");
        return {
          select: (...args: unknown[]) => {
            seen.select = args;
            return { eq: async (...eq: unknown[]) => ((seen.eq = eq), result) };
          },
        };
      },
    };
    return { client: client as never, seen };
  }

  it("asks for a count of pending claims only, without reading any rows", async () => {
    const { client, seen } = counting({ count: 4, error: null });
    expect(await countPendingPayments(client)).toBe(4);
    expect(seen.select).toEqual(["id", { count: "exact", head: true }]);
    expect(seen.eq).toEqual(["status", "PENDING_REVIEW"]);
  });

  it("returns null when the count cannot be read", async () => {
    expect(await countPendingPayments(counting({ count: null, error: { message: "timeout" } }).client)).toBeNull();
  });
});

describe("My projects tells an administrator where customer payments are decided", () => {
  /** The session client the page receives: the admin check and the pending count. */
  function pageClient(isAdmin: boolean, pendingCount: number | null) {
    const calls: string[] = [];
    const client = {
      rpc: async (name: string) => ((calls.push(`rpc:${name}`), name === "is_admin" ? { data: isAdmin, error: null } : { data: null, error: { message: "unknown" } })),
      from: (table: string) => ({
        select: () => ({ eq: async () => ((calls.push(`count:${table}`), pendingCount === null ? { count: null, error: { message: "failed" } } : { count: pendingCount, error: null })) }),
      }),
    };
    return { client, calls };
  }

  async function render(isAdmin: boolean, pendingCount: number | null, projects: unknown[] = []) {
    const { client, calls } = pageClient(isAdmin, pendingCount);
    getPageAccess.mockResolvedValue({ state: "ok", user: { id: isAdmin ? ADMIN : CUSTOMER }, supabase: client });
    listOwnProjects.mockResolvedValue(projects);
    const page = ProjectsPage() as ReactElement<{ children: ReactElement }>;
    const content = page.props.children as ReactElement<object, (p: object) => Promise<ReactElement>>;
    return { html: renderToStaticMarkup(await content.type(content.props)), calls };
  }

  const DRAFT = { id: "b8d43054-1767-4ef5-9f91-c6b20e29d87a", project_type: "INTERIOR", status: "DRAFT", created_at: "2026-10-31T10:00:00Z", updated_at: "2026-10-31T10:00:00Z" };

  it("an administrator whose own project is a draft (the reported screen) is pointed to the waiting payments", async () => {
    const { html } = await render(true, 4, [DRAFT]);
    expect(html).toContain("0 of 4 stages complete");
    expect(html).toContain("4 customer payments are waiting for your review");
    expect(html).toContain('href="/admin/payments"');
    expect(html).toContain("Review payments");
    expect(html).toContain("This page lists only the projects created with this account");
  });

  it("uses the singular for one payment, says so when none wait, and still links when the count fails", async () => {
    expect((await render(true, 1)).html).toContain("1 customer payment is waiting for your review");
    expect((await render(true, 0)).html).toContain("No customer payments are waiting for review");
    const failed = (await render(true, null)).html;
    expect(failed).toContain("Customer payments are reviewed in the admin area");
    expect(failed).toContain('href="/admin/payments"');
  });

  it("a customer sees no administrator notice, and no payment count is read for them", async () => {
    const { html, calls } = await render(false, 7, [DRAFT]);
    expect(html).toContain("0 of 4 stages complete");
    expect(html).not.toContain("You are signed in as an administrator");
    expect(html).not.toContain("waiting for your review");
    expect(html).not.toContain("/admin/payments");
    expect(calls).toEqual(["rpc:is_admin"]);
  });
});
