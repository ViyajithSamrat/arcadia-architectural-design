import { describe, expect, it } from "vitest";
import { milestoneStates } from "@/lib/generation/milestones";

describe("release milestones on the results page", () => {
  it("shows nothing as started before the quote is accepted, or for a cancelled project", () => {
    for (const s of ["DRAFT", "BRIEF_REVIEW", "BRIEF_APPROVED", "QUOTED", "CANCELLED"] as const) {
      expect(milestoneStates(s)).toEqual(["todo", "todo", "todo", "todo", "todo"]);
    }
  });

  it("never marks payment verified merely because evidence was submitted", () => {
    expect(milestoneStates("AWAITING_PAYMENT")).toEqual(["current", "todo", "todo", "todo", "todo"]);
    expect(milestoneStates("PAYMENT_PROOF_SUBMITTED")).toEqual(["done", "current", "todo", "todo", "todo"]);
    expect(milestoneStates("PAYMENT_REJECTED")).toEqual(["problem", "todo", "todo", "todo", "todo"]);
  });

  it("follows generation, review and release", () => {
    expect(milestoneStates("PAYMENT_VERIFIED")).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(milestoneStates("GENERATING")).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(milestoneStates("GENERATION_FAILED")).toEqual(["done", "done", "problem", "todo", "todo"]);
    expect(milestoneStates("READY_FOR_REVIEW")).toEqual(["done", "done", "done", "current", "todo"]);
    expect(milestoneStates("RELEASED")).toEqual(["done", "done", "done", "done", "done"]);
  });
});
