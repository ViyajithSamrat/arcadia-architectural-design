import type { SpeechToTextProvider } from "./interfaces";

/**
 * The MOCK speech-to-text provider. It does not listen to the audio, makes no network call,
 * uses no model and reserves or spends no credits. It always returns the same placeholder,
 * which says plainly that nothing was transcribed, so it can never be mistaken for a real
 * transcription of what the customer said.
 */

export const MOCK_TRANSCRIPT_PREFIX = "[MOCK TRANSCRIPT — no speech service was used]";
export const MOCK_SPEECH_MODEL = "mock-transcript-1";

export const MOCK_TRANSCRIPT =
  `${MOCK_TRANSCRIPT_PREFIX} This placeholder stands in for your recording; nothing you said was transcribed. ` +
  "Replace it with your own description before you save.";

export function createMockSpeechProvider(): SpeechToTextProvider {
  return {
    id: "mock",
    async transcribe() {
      return { transcript: MOCK_TRANSCRIPT, provider: "mock", model: MOCK_SPEECH_MODEL };
    },
  };
}

/** True when text came from the mock provider (its prefix is still at the start). */
export const isMockTranscript = (text: unknown): boolean => typeof text === "string" && text.trimStart().startsWith(MOCK_TRANSCRIPT_PREFIX);

/** True when the mock label appears anywhere in the text, for example after words typed in front of it. */
export const containsMockTranscript = (text: unknown): boolean => typeof text === "string" && text.includes(MOCK_TRANSCRIPT_PREFIX);
