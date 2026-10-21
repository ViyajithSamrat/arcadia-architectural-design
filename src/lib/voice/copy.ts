/**
 * Wording for the voice screens, kept in one place so it cannot be softened on one screen
 * and so tests can assert it. Nothing here claims what the speech provider does with audio:
 * that is not confirmed.
 */

export const VOICE_CONSENT_MOCK =
  "I agree to send this recording to this app's server. In this test mode it is only checked to be a valid WAV file and then discarded: it is not sent to any speech service, it is not stored, and nothing I say is transcribed.";

export const VOICE_CONSENT_LIVE =
  "I agree to send this recording to this app's server, which passes it to Gnani, a third-party speech service, to turn it into text. This app does not store the recording. How long Gnani keeps audio has not been confirmed.";

export const MOCK_VOICE_NOTICE =
  "Test mode: voice input uses a MOCK transcriber. Nothing you say is transcribed and no speech service is used. The text you get back is a fixed placeholder.";

export const MOCK_RESULT_NOTICE = "This is a MOCK transcript. It is a placeholder, not what you said. Edit or replace it before you use it.";

export const MOCK_IN_DESCRIPTION_NOTICE =
  "Your description contains a MOCK transcript placeholder. It is not a transcription of anything you said; edit or replace it before you continue.";

/** Shown under the description field when a save is refused because the placeholder is still in it. */
export const MOCK_DESCRIPTION_REFUSED = "Replace the MOCK transcript placeholder with your own description before you save.";

/** Shown when a brief is requested for a description that still holds the placeholder. */
export const MOCK_BRIEF_REFUSED = "Your description still contains the MOCK transcript placeholder. Edit your description before the brief is created.";

/**
 * Shown with the brief's read-back summary (PR-009, 03_APP_FLOW.md 3.3 step 10). No text-to-speech
 * is connected in this version, so the summary is always given as text.
 */
export const READBACK_TEXT_FALLBACK =
  "Listening to this summary is not available in this version, so it is shown here as text. Nothing about your project depends on hearing it.";

export const DEMO_LANGUAGE_NOTE =
  "Language choices marked as a demo selection only label the test. Support for Tamil and Tamil–English mixed speech (Tanglish) by the real speech service has not been confirmed.";
