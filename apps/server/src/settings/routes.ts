import { type SettingsResponse, type SettingsValues, settingsPatchSchema } from "@bursar/shared";
import { Hono } from "hono";
import type { AuditLog } from "../audit";
import type { EventBus } from "../events/bus";
import type { AppEnv } from "../http/app";
import type { SettingsStore } from "./store";

export interface SettingsRouteDeps {
  store: SettingsStore;
  audit: AuditLog;
  bus: EventBus;
  /** Read-only facts about the deployment, built once from the configuration. */
  system: SettingsResponse["system"];
}

export function settingsRoutes(deps: SettingsRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const respond = (values: SettingsValues): SettingsResponse => ({
    values,
    system: deps.system,
  });

  routes.get("/", (c) => c.json(respond(deps.store.get())));

  routes.patch("/", async (c) => {
    const parsed = settingsPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid settings", code: "invalid_settings" }, 400);
    }
    const { values, changed } = deps.store.update(parsed.data);
    if (changed.length > 0) {
      // Key names only: values such as the notification email never reach the audit log.
      deps.audit.record({
        actor: "user",
        action: "settings.update",
        target: "settings",
        details: { keys: changed.join(",") },
      });
      deps.bus.publish({ type: "settings.updated" });
    }
    return c.json(respond(values));
  });

  return routes;
}
