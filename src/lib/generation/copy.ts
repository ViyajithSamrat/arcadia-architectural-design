/**
 * Wording that must stay exactly as written wherever generated images appear. Kept in one
 * place so a screen cannot quietly soften it, and tests can assert it.
 */

/** Shown on every administrator preview and release confirmation of mock output. */
export const MOCK_WARNING = "MOCK — NOT A DESIGN. Illustrative placeholder only; not construction-ready.";

/** The customer disclaimer when every released image is known to come from the AI image model (no mock wording). */
export const CONCEPT_DISCLAIMER_AI =
  "These images are AI-generated conceptual illustrations made to explore early ideas. They are not construction drawings, engineering plans, CAD or BIM models, and they are not code-compliant or approved for building.";

/** Shown beside every released image: anything written or drawn inside an AI image is part of the picture. */
export const ANNOTATIONS_NOTE =
  "Any labels, annotations, dimensions or measurements that appear inside a generated image are part of the illustration. They are not verified architectural measurements: do not use them for design, construction, ordering or cost estimates. Use measured dimensions and drawings from a qualified professional.";

/** The customer's warning when a released image is from the built-in test generator. */
export const CUSTOMER_MOCK_DETAIL =
  "These pictures come from the built-in test generator. No AI model made them, and they are not a design for your project.";

/** Shown wherever a customer sees released images, when it is not known which images are mock (the safe fallback). */
export const CONCEPT_DISCLAIMER =
  "These images are conceptual illustrations made to explore early ideas. They are not construction drawings, engineering plans, CAD or BIM models, and they are not code-compliant or approved for building. Images marked “MOCK — NOT A DESIGN” are placeholders from the built-in test generator, not real designs.";

/**
 * What the generation queue tells an administrator about the image generator this server uses,
 * one entry per mode of getImageGenerationMode. The queue shows exactly one of them, so it never
 * claims a mode that is not on: mock says nothing is called or spent, live says credits are used,
 * and an incomplete live setting says generation cannot start (it never turns into mock images).
 */
export const GENERATION_MODE_NOTICE = {
  mock: {
    title: "Mock generation is on: test images only",
    body: "Generating here creates placeholder images with the built-in test generator. Every image is labelled “MOCK — NOT A DESIGN.” No AI image model is called and nothing is spent. Live image generation is not switched on for this server.",
  },
  live: {
    title: "Live image generation is on: it uses credits",
    body: "Generating here sends the approved brief to the configured AI image model. Each image is billed and there is no automatic retry. Generation starts by itself when a payment is verified, and finished images are released to the customer automatically unless GENERATION_AUTO_RELEASE is set to false.",
  },
  live_unavailable: {
    title: "Live image generation is requested but not available",
    body: "This server is set to live mode, but the image model settings are incomplete or not valid, so generation cannot start. It does not fall back to mock images. Fix the settings, or restart the server in mock mode.",
  },
} as const;

/** What an administrator is told becomes visible when they release. */
export const RELEASE_EXPLANATION =
  "Releasing makes every image listed above visible to the customer who owns this project, and they will be able to open and download them from their account. It cannot be undone. Real (non-placeholder) images are normally released automatically when generation finishes; this release is for placeholders, or for when automatic release is switched off.";
