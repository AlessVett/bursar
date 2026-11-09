import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export function accessGuard(options: {
  teamDomain: string;
  audience: string;
  getKey?: JWTVerifyGetKey;
}): MiddlewareHandler {
  const issuer = `https://${options.teamDomain}`;
  const getKey = options.getKey ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (c, next) => {
    if (c.req.path === "/healthz") return next();
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) return c.json({ error: "Missing Cloudflare Access token" }, 403);
    try {
      await jwtVerify(token, getKey, { issuer, audience: options.audience });
    } catch {
      return c.json({ error: "Invalid Cloudflare Access token" }, 403);
    }
    await next();
  };
}
