import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originCheck(publicUrl: URL): MiddlewareHandler {
  const expected = publicUrl.origin;
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && c.req.header("origin") !== expected) {
      return c.json({ error: "Cross-origin request rejected" }, 403);
    }
    await next();
  };
}
