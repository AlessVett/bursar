import { Hono } from "hono";
import type { AppEnv } from "../http/app";

/** The only parameters the bank's redirect may carry to the panel (eb-api-notes §4). */
export const CALLBACK_PARAMS = ["state", "code", "error", "error_description"] as const;
export const CALLBACK_PARAM_MAX_LENGTH = 512;
export const CALLBACK_PAGE_PATH = "/connect/callback";

/**
 * `GET /api/banks/callback`, the `redirect_url` registered at Enable Banking. It is public because
 * the `SameSite=Strict` session cookie is not sent on the bank's cross-site redirect: it does no
 * work and only forwards the known parameters to the panel page, which posts them to the
 * authenticated `POST /api/connections/complete`. The query is never logged (the request log has
 * the path only), never cached and never sent on as a referrer.
 */
export function bankCallbackRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.get("/", (c) => {
    const forwarded = new URLSearchParams();
    for (const name of CALLBACK_PARAMS) {
      const value = c.req.query(name);
      if (value) forwarded.set(name, value.slice(0, CALLBACK_PARAM_MAX_LENGTH));
    }
    const query = forwarded.toString();
    return new Response(null, {
      status: 303,
      headers: {
        Location: query ? `${CALLBACK_PAGE_PATH}?${query}` : CALLBACK_PAGE_PATH,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  });
  return routes;
}
