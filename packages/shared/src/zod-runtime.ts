import { z } from "zod";

/**
 * Zod 4 probes for `new Function("")` when an object schema is built, to decide whether it can
 * compile validators. Under a CSP without `unsafe-eval` the probe is caught by Zod but still
 * raises a `securitypolicyviolation` and a console error. In a browser (a `document` exists)
 * this switches Zod to its interpreted path, which is plenty for form-sized payloads; the server
 * keeps the compiled path.
 *
 * The probe runs while schemas are created, so every module that defines schemas imports this
 * file first (`import "./zod-runtime"`); it must stay ahead of the first `z.object(...)`.
 */
export function configureZodRuntime(scope: object = globalThis): void {
  if ("document" in scope) z.config({ jitless: true });
}

configureZodRuntime();
