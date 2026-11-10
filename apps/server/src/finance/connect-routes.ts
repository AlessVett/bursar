import {
  completeConnectionRequestSchema,
  renewConnectionRequestSchema,
  startConnectionRequestSchema,
} from "@bursar/shared";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/app";
import { ConnectError, type ConnectService } from "./connect";

const ID_PATTERN = /^[1-9]\d{0,15}$/;

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

function parseId(value: string): number | null {
  if (!ID_PATTERN.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function notConfigured(c: Context) {
  return c.json({ error: "Enable Banking is not configured", code: "banking_not_configured" }, 503);
}

function invalidRequest(c: Context) {
  return c.json({ error: "Invalid request", code: "invalid_request" }, 400);
}

function failure(c: Context, error: unknown) {
  if (error instanceof ConnectError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  throw error;
}

/**
 * `/api/connections`: start a connection, complete it from the callback page, renew a consent.
 * Mounted behind the session and the Origin check. The 503 is answered per route, never by a
 * wildcard middleware, because other routers share the `/api/connections/...` paths.
 */
export function connectRoutes(deps: { service: ConnectService | null }): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post("/", async (c) => {
    const { service } = deps;
    if (!service) return notConfigured(c);
    const parsed = startConnectionRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c);
    try {
      return c.json(await service.start(parsed.data));
    } catch (error) {
      return failure(c, error);
    }
  });

  routes.post("/complete", async (c) => {
    const { service } = deps;
    if (!service) return notConfigured(c);
    const parsed = completeConnectionRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalidRequest(c);
    try {
      return c.json(await service.complete(parsed.data));
    } catch (error) {
      return failure(c, error);
    }
  });

  routes.post("/:connectionId/renew", async (c) => {
    const { service } = deps;
    if (!service) return notConfigured(c);
    const connectionId = parseId(c.req.param("connectionId"));
    if (connectionId === null) {
      return c.json({ error: "Connection not found", code: "not_found" }, 404);
    }
    // The body is optional: no body means the configured consent duration.
    const parsed = renewConnectionRequestSchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidRequest(c);
    try {
      return c.json(await service.renew(connectionId, parsed.data));
    } catch (error) {
      return failure(c, error);
    }
  });

  return routes;
}
