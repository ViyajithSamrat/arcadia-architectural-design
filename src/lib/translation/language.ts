/** True for a provider language code that is English, where no translation is needed. Safe for the browser. */
export const isEnglishLanguage = (code: string | null | undefined): boolean => typeof code === "string" && /^en(?:-|$)/i.test(code);
