import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The form only calls this; the server side is tested in journey-actions and voice-persistence tests.
vi.mock("@/app/(app)/projects/actions", () => ({ saveStepAction: vi.fn() }));

const { VoiceCapture } = await import("@/components/journey/voice-capture");
const { StepForm } = await import("@/components/journey/step-form");
const { ReadbackSummary } = await import("@/components/journey/readback-summary");
const { getVoiceView, TANGLISH_DEMO } = await import("@/lib/journeys/voice");
const { MOCK_TRANSCRIPT } = await import("@/lib/providers/mock-speech");
const copy = await import("@/lib/voice/copy");

const ID = "33333333-3333-4333-8333-333333333333";
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => decode(renderToStaticMarkup(node));

const mockView = getVoiceView({ GNANI_VOICE_ENABLED: "mock" });
if (mockView.state !== "mock") throw new Error("expected mock view");

const capture = (mode: "mock" | "live" = "mock") =>
  html(createElement(VoiceCapture, { projectId: ID, mode, languages: mockView.languages, maxSeconds: 30, uploadTimeoutMs: mockView.uploadTimeoutMs, onUse: () => undefined }));

/** The opening tag of the first element containing `text`, or of the input before a label text. */
const tagWith = (out: string, text: string) => {
  const i = out.indexOf(text);
  const start = out.lastIndexOf("<", i);
  return out.slice(start, out.indexOf(">", start) + 1);
};

describe("VoiceCapture before consent", () => {
  it("shows the consent text with an unticked box, and keeps the microphone and file choice disabled", () => {
    const out = capture();
    expect(out).toContain(copy.VOICE_CONSENT_MOCK);
    const checkbox = out.match(/<input type="checkbox"[^>]*>/)?.[0] ?? "";
    expect(checkbox).not.toContain("checked");
    expect(tagWith(out, "Start recording")).toContain("disabled");
    expect(tagWith(out, "Choose a WAV file")).toContain("disabled");
    expect(out.match(/<input[^>]*type="file"[^>]*>/)?.[0]).toContain("disabled");
    expect(out).toContain("Tick the box above to enable the microphone and file choice.");
  });

  it("shows a prominent Mock badge and explanation in mock mode", () => {
    const out = capture();
    expect(out).toMatch(/data-testid="voice-mode-badge"[^>]*>Mock</);
    expect(out).toContain(copy.MOCK_VOICE_NOTICE);
  });

  it("offers Tamil and a Tanglish demo selection without describing either as a confirmed live capability", () => {
    const out = capture();
    expect(out).toContain('value="ta-IN"');
    expect(out).toContain(`value="${TANGLISH_DEMO}"`);
    expect(out).toContain("demo selection, not a confirmed speech-service language");
    expect(out).toContain(copy.DEMO_LANGUAGE_NOTE);
    expect(out).not.toMatch(/Tanglish[^<]*(is supported|supported by Gnani|live)/i);
  });

  it("in live mode names the third-party service, does not claim its retention, and shows no Mock badge", () => {
    const out = capture("live");
    expect(out).toContain(copy.VOICE_CONSENT_LIVE);
    expect(copy.VOICE_CONSENT_LIVE).toMatch(/has not been confirmed/);
    expect(out).not.toContain("voice-mode-badge");
  });

  it("has no form of its own and no named inputs, so it cannot submit or pollute the step's answers", () => {
    const out = capture();
    expect(out).not.toContain("<form");
    expect(out).not.toMatch(/<(input|select|textarea)[^>]* name=/);
    expect(out.match(/<button[^>]*>/g)?.every((b) => b.includes('type="button"'))).toBe(true);
  });
});

describe("the description step", () => {
  const step = (voice: Parameters<typeof StepForm>[0]["voice"], initial: Record<string, unknown> = {}) =>
    html(createElement(StepForm, { projectId: ID, projectType: "EMPTY_PLOT", stepId: "description", initial, voice }));

  it("keeps manual typing available when voice is off, unavailable or on", () => {
    for (const voice of [{ state: "off" } as const, { state: "unavailable" } as const, mockView]) {
      const out = step(voice);
      expect(out).toMatch(/<textarea[^>]*name="text"/);
      expect(out).toContain("Save and review your brief");
    }
    expect(step({ state: "off" })).toContain("Voice input not configured");
    expect(step({ state: "unavailable" })).toContain("Voice input unavailable");
    expect(step(mockView)).toContain("Speak your description");
  });

  it("keeps a saved mock transcript visibly marked", () => {
    const out = step(mockView, { text: MOCK_TRANSCRIPT });
    expect(out).toContain(copy.MOCK_IN_DESCRIPTION_NOTICE);
    expect(step(mockView, { text: "A three-bedroom house" })).not.toContain(copy.MOCK_IN_DESCRIPTION_NOTICE);
  });

  it("shows no voice controls on other steps", () => {
    const out = html(createElement(StepForm, { projectId: ID, projectType: "EMPTY_PLOT", stepId: "space", initial: {}, voice: mockView }));
    expect(out).not.toContain("Speak your description");
  });
});

describe("ReadbackSummary (PR-009: text fallback while spoken read-back is not switched on)", () => {
  it("keeps the summary visible as text and explains why it cannot be heard", () => {
    const out = html(createElement(ReadbackSummary, { text: "  A new two-floor home on a 30 × 40 ft plot.  " }));
    expect(out).toContain("Read-back summary");
    expect(out).toContain("A new two-floor home on a 30 × 40 ft plot.");
    expect(out).toContain(copy.READBACK_TEXT_FALLBACK);
    expect(copy.READBACK_TEXT_FALLBACK).toMatch(/not switched on in this setup, so the summary is shown here as text/);
  });

  it("offers nothing that looks like working audio", () => {
    const out = html(createElement(ReadbackSummary, { text: "Summary" }));
    expect(out).not.toMatch(/<audio|<button|Play|Listen to/i);
  });

  it("says so when the brief has no separate summary, and still explains the fallback", () => {
    const out = html(createElement(ReadbackSummary, { text: "   " }));
    expect(out).toContain("No separate summary was produced for this brief");
    expect(out).toContain(copy.READBACK_TEXT_FALLBACK);
  });

  it("renders the summary as text, never as markup", () => {
    const out = renderToStaticMarkup(createElement(ReadbackSummary, { text: "<script>alert(1)</script>" }));
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});
