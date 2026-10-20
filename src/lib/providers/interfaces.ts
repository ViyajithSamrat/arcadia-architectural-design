/**
 * Provider boundaries (02_TRD.md section 2.5). Live adapters, test fakes and disabled
 * stand-ins share these contracts, so callers never depend on a vendor.
 *
 * Everything a provider returns is UNTRUSTED data: callers validate it before use, and
 * nothing here lets a provider decide a status, a price, a role or a release.
 */

/** What a provider reports back about one call. Never contains prompts, transcripts or keys. */
export type ProviderUsage = {
  requestId?: string | null;
  model?: string | null;
  /** Units the provider says were used, when it says. Gnani returns none. */
  units?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
};

/** Lets the budget guard see whether a call was really made. */
export type ProviderHooks = {
  /** Called immediately before the network request is sent. */
  onSent?: () => void;
  /**
   * Called when the adapter refuses a call BEFORE anything could be sent (for example an
   * unsupported language). Only then is the reserved usage released; any other failure
   * counts as a made call.
   */
  onNotSent?: () => void;
  /** Called with whatever usage the provider reported. */
  onUsage?: (usage: ProviderUsage) => void;
};

export type ProviderErrorCode =
  | "not_configured"
  | "unsupported_input"
  | "auth"
  | "rate_limited"
  | "timeout"
  | "bad_request"
  | "bad_response"
  | "server";

/** A provider failure. The message is safe to log; it never carries a payload or a key. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface SpeechToTextProvider {
  readonly id: string;
  transcribe(
    input: { audio: Uint8Array; mimeType: string; language: string; requestId: string },
    hooks?: ProviderHooks,
  ): Promise<{ transcript: string; provider: string; model?: string; requestId?: string }>;
}

export interface TextToSpeechProvider {
  readonly id: string;
  synthesize(
    input: { text: string; language: string; requestId: string },
    hooks?: ProviderHooks,
  ): Promise<{ audio: Uint8Array; mimeType: string; provider: string; model?: string }>;
}
