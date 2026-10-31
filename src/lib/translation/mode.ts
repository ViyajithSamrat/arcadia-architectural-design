import { isSet } from "@/lib/env/schema";
import { getOpenRouterConfig, type OpenRouterConfig } from "@/lib/providers/config";

/**
 * Transcript translation mode, decided only by TRANSLATION_MODE and independent of
 * PROVIDER_MODE (which decides the brief writer and the image generator):
 *   unset, empty or "off"  off: the customer types the English version themselves
 *   "live"                 OpenRouter text translation, only when the OpenRouter key and text
 *                          model are configured; otherwise unavailable, never a mock
 *   anything else          invalid: unavailable (fail closed)
 *
 * Gnani speech-to-text returns text in the spoken language only; it does not translate.
 * Translation is a separate, explicit step the customer asks for, and its output is a
 * suggestion they review and correct before it becomes their description.
 */

export type TranslationMode = { kind: "off" } | { kind: "unavailable" } | { kind: "live"; config: OpenRouterConfig };

export function getTranslationMode(env: Record<string, string | undefined> = process.env): TranslationMode {
  const raw = isSet(env, "TRANSLATION_MODE") ? String(env.TRANSLATION_MODE).trim().toLowerCase() : "";
  if (raw === "" || raw === "off") return { kind: "off" };
  if (raw !== "live") return { kind: "unavailable" };
  const config = getOpenRouterConfig(env);
  return config ? { kind: "live", config } : { kind: "unavailable" };
}

/** What the screen may know. No setting names, values or keys. */
export type TranslationView = "off" | "unavailable" | "live";

export function getTranslationView(env: Record<string, string | undefined> = process.env): TranslationView {
  return getTranslationMode(env).kind;
}

export { isEnglishLanguage } from "./language";
