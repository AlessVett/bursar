import { purgeRequestSchema } from "@bursar/shared";
import { Hono } from "hono";
import type { AppEnv } from "../http/app";
import { AlreadyRemovedError, type ConnectionLifecycle } from "./lifecycle";

const ID_PATTERN = /^[1-9]\d{0,14}$/;
const NOT_FOUND = { error: "Not found", code: "not_found" } as const;

/** A positive integer id from the path, or null; the raw value is never echoed back. */
function parseId(value: string): number | null {
  return ID_PATTERN.test(value) ? Number(value) : null;
}

export function lifecycleRoutes(deps: { lifecycle: ConnectionLifecycle }): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/connections/:connectionId/removal-preview", (c) => {
    const id = parseId(c.req.param("connectionId"));
    const preview = id === null ? null : deps.lifecycle.removalPreview(id);
    return preview ? c.json(preview) : c.json(NOT_FOUND, 404);
  });

  routes.delete("/connections/:connectionId", async (c) => {
    const id = parseId(c.req.param("connectionId"));
    if (id === null) return c.json(NOT_FOUND, 404);
    try {
      const result = await deps.lifecycle.disconnect(id);
      return result ? c.json(result) : c.json(NOT_FOUND, 404);
    } catch (error) {
      if (error instanceof AlreadyRemovedError) {
        return c.json({ error: "The connection is already removed", code: "already_removed" }, 409);
      }
      throw error;
    }
  });

  routes.post("/accounts/:accountId/purge", async (c) => {
    const id = parseId(c.req.param("accountId"));
    if (id === null) return c.json(NOT_FOUND, 404);
    const body = purgeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { error: "Purging needs an explicit confirmation", code: "confirmation_required" },
        400,
      );
    }
    const result = deps.lifecycle.purgeAccount(id);
    if (result === null) return c.json(NOT_FOUND, 404);
    if (result === "not_removed") {
      return c.json(
        { error: "Only a removed account can be purged", code: "account_not_removed" },
        409,
      );
    }
    return c.json(result);
  });

  return routes;
}
