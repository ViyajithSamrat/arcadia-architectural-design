import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrief, readTranscriptInput, saveStep, type TranscriptInput } from "@/lib/journeys/service";
import { MOCK_TRANSCRIPT } from "@/lib/providers/mock-speech";
import { MOCK_BRIEF_REFUSED, MOCK_DESCRIPTION_REFUSED } from "@/lib/voice/copy";
import {
  signTranscriptToken,
  TRANSCRIPT_TOKEN_TTL_MS,
  transcriptSigningKey,
  verifyTranscriptToken,
  type TranscriptKey,
  type TranscriptSource,
} from "@/lib/voice/provenance";
import { FakeDb } from "./support/fake-supabase";
import { storedRequirements } from "./support/journey-fixtures";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";

/** The key the server would sign with (VOICE_TRANSCRIPT_SECRET) in these tests. */
const KEY: TranscriptKey = { secret: Buffer.from("persistence-test-secret-0123456789abcdef"), mockOnly: false };

let db: FakeDb;
/** The trusted (service role) view of the same data, with its own write log. */
let svc: FakeDb;
const client = () => db.client() as SupabaseClient;
const service = () => svc.client() as SupabaseClient;
const row = () => db.rows("projects")[0] as Record<string, unknown>;

beforeEach(() => {
  db = new FakeDb().seed("projects", [
    { id: PROJECT, customer_id: ME, project_type: "EMPTY_PLOT", status: "DRAFT", source_language: "en", requirements_json: storedRequirements("EMPTY_PLOT"), english_brief_json: null, english_brief_text: null },
  ]);
  svc = new FakeDb();
  svc.tables = db.tables;
});

/** A transcript as the browser sends it after "Use this text", with a token the server signed over `original`. */
function chosen(
  original: string,
  used: string,
  claims: { source?: TranscriptSource; sourceLanguage?: string | null; userId?: string; projectId?: string; key?: TranscriptKey; issuedAt?: number } = {},
): TranscriptInput {
  const provenance = signTranscriptToken(
    { userId: claims.userId ?? ME, projectId: claims.projectId ?? PROJECT, transcript: original, source: claims.source ?? "mock", sourceLanguage: claims.sourceLanguage ?? null },
    claims.key ?? KEY,
    claims.issuedAt ?? Date.now(),
  );
  return { original, used, provenance };
}

/** saveStep as the server action calls it, verifying tokens against the test key. */
const save = (text: string, transcript?: TranscriptInput, options: { liveTranscription?: boolean } = {}, user = ME, step = "description") =>
  saveStep(client(), user, PROJECT, step, step === "description" ? { text } : (storedRequirements("EMPTY_PLOT")[step] as Record<string, unknown>), transcript, {
    verifyTranscript: (token, expected) => verifyTranscriptToken(token, expected, [KEY]),
    service,
    ...options,
  });

describe("readTranscriptInput (shape only; the token is checked in saveStep)", () => {
  it("accepts the text as it came back, the text put into the description, and a token", () => {
    expect(readTranscriptInput({ original: "  hello  ", used: " hello there ", provenance: "v1.a.b" })).toEqual({ original: "hello", used: "hello there", provenance: "v1.a.b" });
  });

  it.each([
    null,
    "text",
    [],
    { original: "", used: "hi", provenance: "t" },
    { original: "x".repeat(5001), used: "hi", provenance: "t" },
    { original: 5, used: "hi", provenance: "t" },
    { original: "hi", provenance: "t" },
    { original: "hi", used: "  ", provenance: "t" },
    { original: "hi", used: 5, provenance: "t" },
    { original: "hi", used: "hi" },
    { original: "hi", used: "hi", provenance: "" },
    { original: "hi", used: "hi", provenance: 5 },
    { original: "hi", used: "hi", provenance: "x".repeat(2049) },
    // The old payload, with the language claimed by the browser, is no longer accepted.
    { original: "hi", used: "hi", sourceLanguage: "ta-IN" },
  ])("refuses %j", (value) => {
    expect(readTranscriptInput(value)).toBeNull();
  });
});

/** Description saves are written by the trusted client only (R1-C). */
const updates = () => svc.writes.filter((w) => w.table === "projects" && w.op === "update");
const allWrites = () => [...db.writes, ...svc.writes];
const replaceProject = (patch: Record<string, unknown>) => {
  db.tables.projects = [{ ...row(), ...patch }];
};

/** A project whose description was saved from a transcript by an earlier build, with a stale language. */
const seedStaleVoiceProject = () =>
  replaceProject({
    source_language: "ta-IN",
    transcript_original: MOCK_TRANSCRIPT,
    transcript_corrected: "Three bedrooms, open kitchen",
    requirements_json: { ...storedRequirements("EMPTY_PLOT"), description: { text: "Three bedrooms, open kitchen" } },
  });

/** Neither transcript column holds anything (a fixture row may not have them at all). */
const expectNoTranscript = () => {
  expect(row().transcript_original ?? null).toBeNull();
  expect(row().transcript_corrected ?? null).toBeNull();
};

describe("saveStep with a chosen transcript", () => {
  it("stores the transcript as it came back and the saved description as the corrected text; the status is untouched", async () => {
    const result = await save("Three bedrooms, open kitchen", chosen(MOCK_TRANSCRIPT, "Three bedrooms, open kitchen"));
    expect(result).toMatchObject({ ok: true });
    expect(row()).toMatchObject({ status: "DRAFT", transcript_original: MOCK_TRANSCRIPT, transcript_corrected: "Three bedrooms, open kitchen" });
    expect(updates()[0].payload).not.toHaveProperty("status");
  });

  it("a mock run never changes the project's language, whatever language was selected", async () => {
    await save("Three bedrooms, open kitchen", chosen(MOCK_TRANSCRIPT, "Three bedrooms, open kitchen", { sourceLanguage: "ta-IN" }));
    expect(row().source_language).toBe("en");
    expect(updates()[0].payload).not.toHaveProperty("source_language");
  });

  it("in R1-A no transcript sets the language, even a server-signed Gnani one", async () => {
    await save("Three bedrooms", chosen("Three bedrooms", "Three bedrooms", { source: "gnani", sourceLanguage: "ta-IN" }));
    expect(row().source_language).toBe("en");
  });

  it("only a live, server-signed Gnani transcript could set the language, and never one carrying the mock label", async () => {
    await save("Three bedrooms", chosen(MOCK_TRANSCRIPT, "Three bedrooms", { source: "gnani", sourceLanguage: "ta-IN" }), { liveTranscription: true });
    expect(row().source_language).toBe("en");
    await save("Three bedrooms", chosen("மூன்று படுக்கையறைகள்", "Three bedrooms", { source: "mock", sourceLanguage: "ta-IN" }), { liveTranscription: true });
    expect(row().source_language).toBe("en");
    await save("Three bedrooms", chosen("மூன்று படுக்கையறைகள்", "Three bedrooms", { source: "gnani", sourceLanguage: "ta-IN" }), { liveTranscription: true });
    expect(row().source_language).toBe("ta-IN");
  });

  it("resets a stale language when a transcript is replaced, including by a demo-only selection", async () => {
    seedStaleVoiceProject();
    await save("A courtyard house", chosen("A courtyard house", "A courtyard house", { sourceLanguage: null }));
    expect(row()).toMatchObject({ source_language: "en", transcript_original: "A courtyard house", transcript_corrected: "A courtyard house" });
  });

  it("switching to typed text clears the old transcript and resets the language", async () => {
    seedStaleVoiceProject();
    await save("Typed by hand instead");
    expect(row()).toMatchObject({ source_language: "en", transcript_original: null, transcript_corrected: null });
  });

  it("saving the transcript's description again unchanged keeps the transcript, but not a language it could not prove", async () => {
    seedStaleVoiceProject();
    await save("Three bedrooms, open kitchen");
    expect(row()).toMatchObject({ source_language: "en", transcript_original: MOCK_TRANSCRIPT, transcript_corrected: "Three bedrooms, open kitchen" });
    expect(Object.keys(updates()[0].payload as object).sort()).toEqual(["requirements_json", "source_language"]);
  });

  it("writes nothing for a malformed transcript payload, a transcript on another step, or someone else's project", async () => {
    expect(await saveStep(client(), ME, PROJECT, "description", { text: "x" }, { original: "x", used: "x" } as never, { service })).toMatchObject({ ok: false });
    expect(await save("x", chosen("x", "x"), {}, ME, "space")).toMatchObject({ ok: false });
    expect(await save("x", chosen("x", "x"), {}, OTHER)).toMatchObject({ ok: false });
    expect(allWrites()).toHaveLength(0);
  });

  it("without a transcript behaves exactly as before", async () => {
    await save("Typed by hand");
    expect(Object.keys(updates()[0].payload ?? {})).toEqual(["requirements_json"]);
  });
});

describe("transcript provenance at the save (R1-B)", () => {
  /** The description is saved, but as typed text: no transcript column is written. */
  const expectSavedAsTyped = (result: unknown) => {
    expect(result).toMatchObject({ ok: true });
    expectNoTranscript();
    expect(row().source_language).toBe("en");
    expect(Object.keys(updates()[0].payload as object)).toEqual(["requirements_json"]);
  };

  it("a token the browser made up is not a transcript: the text is saved as typed", async () => {
    expectSavedAsTyped(await save("Three bedrooms", { original: "Three bedrooms", used: "Three bedrooms", provenance: "v1.e30.AAAA" }));
  });

  it("a token signed with another key is not accepted", async () => {
    const other: TranscriptKey = { secret: Buffer.from("not-the-server-secret-but-long-enough-00"), mockOnly: false };
    expectSavedAsTyped(await save("Three bedrooms", chosen("Three bedrooms", "Three bedrooms", { source: "gnani", sourceLanguage: "ta-IN", key: other })));
  });

  it("a token for another project or another user is not accepted (no moving a transcript between projects)", async () => {
    expectSavedAsTyped(await save("Three bedrooms", chosen("Three bedrooms", "Three bedrooms", { projectId: OTHER_PROJECT })));
    svc.writes.length = 0;
    expectSavedAsTyped(await save("Three bedrooms", chosen("Three bedrooms", "Three bedrooms", { userId: OTHER })));
  });

  it("a genuine token presented with different text is not accepted", async () => {
    const real = chosen("Three bedrooms", "Three bedrooms");
    expectSavedAsTyped(await save("Four bedrooms", { original: "Four bedrooms", used: "Four bedrooms", provenance: real.provenance }));
  });

  it("an expired token is not accepted, but the description itself is still saved", async () => {
    expectSavedAsTyped(await save("Three bedrooms", chosen("Three bedrooms", "Three bedrooms", { issuedAt: Date.now() - TRANSCRIPT_TOKEN_TTL_MS - 1000 })));
  });

  it("presenting the same genuine token again for the same project and text only re-saves the same values", async () => {
    const choice = chosen("Three bedrooms", "Three bedrooms");
    await save("Three bedrooms", choice);
    const first = { ...row() };
    await save("Three bedrooms", choice);
    expect(row()).toMatchObject({ transcript_original: first.transcript_original, transcript_corrected: first.transcript_corrected, source_language: first.source_language });
  });

  it("by default the save trusts the key the transcribe route would use for the mock in this process", async () => {
    const processKey = transcriptSigningKey("mock", {});
    expect(processKey?.mockOnly).toBe(true);
    const choice = chosen("Three bedrooms", "Three bedrooms", { key: processKey! });
    expect(await saveStep(client(), ME, PROJECT, "description", { text: "Three bedrooms" }, choice, { service })).toMatchObject({ ok: true });
    expect(row()).toMatchObject({ transcript_original: "Three bedrooms" });
  });
});

describe("a transcript chosen and then edited in the same visit (N-1)", () => {
  const ORIGINAL = "Three bedrooms and a garden";
  const USED = "Three bedrooms and a big garden";

  it("unchanged: the description is still exactly the chosen text, so the transcript is stored", async () => {
    await save(USED, chosen(ORIGINAL, USED));
    expect(row()).toMatchObject({ transcript_original: ORIGINAL, transcript_corrected: USED, source_language: "en" });
  });

  it("surrounding whitespace in the field does not count as an edit", async () => {
    await save(`  ${USED}\n`, chosen(ORIGINAL, USED));
    expect(row()).toMatchObject({ transcript_original: ORIGINAL, transcript_corrected: USED });
  });

  it("edited: a description changed away from the chosen text saves as typed text, with no transcript", async () => {
    await save(`${USED}, facing east`, chosen(ORIGINAL, USED));
    expectNoTranscript();
    expect(row().source_language).toBe("en");
    expect(Object.keys(updates()[0].payload as object)).toEqual(["requirements_json"]);
  });

  it("replaced: typed text instead of the chosen transcript clears a transcript saved earlier", async () => {
    seedStaleVoiceProject();
    await save("Something else entirely", chosen(ORIGINAL, USED));
    expect(row()).toMatchObject({ transcript_original: null, transcript_corrected: null, source_language: "en" });
  });

  it("the language rules are unchanged: an edited live transcript does not keep its language", async () => {
    const live = chosen("மூன்று படுக்கையறைகள்", USED, { source: "gnani", sourceLanguage: "ta-IN" });
    await save("Edited by hand", live, { liveTranscription: true });
    expect(row().source_language).toBe("en");
    await save(USED, live, { liveTranscription: true });
    expect(row().source_language).toBe("ta-IN");
  });
});

describe("the mock placeholder at the server boundary", () => {
  it.each([MOCK_TRANSCRIPT, `Our plot is small. ${MOCK_TRANSCRIPT}`])("is never saved as the description: %s", async (text) => {
    const result = await save(text, chosen(MOCK_TRANSCRIPT, text));
    expect(result).toMatchObject({ ok: false, fieldErrors: { text: MOCK_DESCRIPTION_REFUSED } });
    expect(await save(text)).toMatchObject({ ok: false });
    expect(allWrites()).toHaveLength(0);
  });

  it("an edited description is saved normally", async () => {
    expect(await save("Three bedrooms", chosen(MOCK_TRANSCRIPT, "Three bedrooms"))).toMatchObject({ ok: true });
  });

  it("a description saved with the placeholder by an earlier build never reaches a brief writer", async () => {
    replaceProject({ requirements_json: { ...storedRequirements("EMPTY_PLOT"), description: { text: MOCK_TRANSCRIPT } } });
    const generate = vi.fn();
    const result = await createBrief(client(), client(), ME, PROJECT, { id: "mock", generate });
    expect(result).toEqual({ ok: false, message: MOCK_BRIEF_REFUSED });
    expect(generate).not.toHaveBeenCalled();
    expect(allWrites()).toHaveLength(0);
  });
});

describe("who writes the description step (R1-C: customers cannot write the transcript columns)", () => {
  it("the description step is written by the trusted client only, never the customer's session", async () => {
    expect(await save("Three bedrooms", chosen("Three bedrooms", "Three bedrooms"))).toMatchObject({ ok: true });
    expect(db.writes).toHaveLength(0);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].payload).toMatchObject({ transcript_original: "Three bedrooms", transcript_corrected: "Three bedrooms" });
  });

  it("a typed save that clears a stored transcript is also written by the trusted client", async () => {
    seedStaleVoiceProject();
    await save("Typed instead");
    expect(db.writes).toHaveLength(0);
    expect(updates()[0].payload).toMatchObject({ transcript_original: null, transcript_corrected: null, source_language: "en" });
  });

  it("other steps are still written with the customer's own session", async () => {
    expect(await save("", undefined, {}, ME, "space")).toMatchObject({ ok: true });
    expect(svc.writes).toHaveLength(0);
    expect(db.writes.filter((w) => w.op === "update")).toHaveLength(1);
  });

  it("writes nothing when the trusted client is missing or cannot be created", async () => {
    expect(await saveStep(client(), ME, PROJECT, "description", { text: "Three bedrooms" })).toMatchObject({ ok: false });
    const failing = () => {
      throw new Error("service role key missing");
    };
    expect(await saveStep(client(), ME, PROJECT, "description", { text: "Three bedrooms" }, undefined, { service: failing })).toMatchObject({ ok: false });
    expect(allWrites()).toHaveLength(0);
  });

  it("the trusted write keeps the owner and status conditions: a project that changed since it was read is not written", async () => {
    // The trusted client sees the project already moved on (as if a quote was accepted meanwhile).
    svc = new FakeDb().seed("projects", [{ ...row(), status: "QUOTED" }]);
    expect(await save("Three bedrooms", chosen("Three bedrooms", "Three bedrooms"))).toMatchObject({ ok: false });
    expect(svc.rows("projects")[0]).toMatchObject({ status: "QUOTED" });
    expect(svc.rows("projects")[0].transcript_original ?? null).toBeNull();
    // ...and a project of another customer is never matched either.
    svc = new FakeDb().seed("projects", [{ ...row(), customer_id: OTHER }]);
    expect(await save("Three bedrooms", chosen("Three bedrooms", "Three bedrooms"))).toMatchObject({ ok: false });
    expect(svc.rows("projects")[0].transcript_original ?? null).toBeNull();
  });
});
