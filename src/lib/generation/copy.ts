/**
 * Wording that must stay exactly as written wherever generated images appear. Kept in one
 * place so a screen cannot quietly soften it, and tests can assert it.
 */

/** Shown on every administrator preview and release confirmation of mock output. */
export const MOCK_WARNING = "MOCK — NOT A DESIGN. Illustrative placeholder only; not construction-ready.";

/** Shown wherever a customer sees released images. */
export const CONCEPT_DISCLAIMER =
  "These images are conceptual illustrations made to explore early ideas. They are not construction drawings, engineering plans, CAD or BIM models, and they are not code-compliant or approved for building. Images marked “MOCK — NOT A DESIGN” are placeholders from this prototype's test generator, not real designs.";

/** What an administrator is told becomes visible when they release. */
export const RELEASE_EXPLANATION =
  "Releasing makes every image listed above visible to the customer who owns this project, and they will be able to open and download them from their account. It cannot be undone. Nothing is released automatically when images are generated.";
