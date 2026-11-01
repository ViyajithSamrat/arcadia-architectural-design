import { z } from "zod";

/**
 * Runs in the browser before the application code (Next.js instrumentation-client).
 *
 * Zod builds fast object parsers with the Function constructor and probes for that ability
 * with a caught empty call. The Content-Security-Policy has no 'unsafe-eval', so the browser
 * reports the probe as a violation even though Zod recovers. `jitless` turns off both the
 * probe and the compiled parsers. Zod decides when an object schema is BUILT, so this must
 * run before any client module defines a schema, which is why it lives here.
 */
z.config({ jitless: true });
