import {
  NOTIFICATION_DEFAULT_LIMIT,
  notificationListQuerySchema,
  type TestEmailResponse,
} from "@bursar/shared";
import { Hono } from "hono";
import type { AppEnv } from "../http/app";
import type { SettingsStore } from "../settings/store";
import type { Mailer } from "./mailer";
import type { NotificationService } from "./service";
import { panelUrlFor, renderEmail } from "./templates";

export interface NotificationRoutesDeps {
  service: NotificationService;
  /** `null` when SMTP is not configured. */
  mailer: Mailer | null;
  settings: SettingsStore;
  publicUrl: URL;
}

export function notificationRoutes(deps: NotificationRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/", (c) => {
    const query = notificationListQuerySchema.safeParse({ limit: c.req.query("limit") });
    if (!query.success) return c.json({ error: "Invalid request" }, 400);
    return c.json(deps.service.list(query.data.limit ?? NOTIFICATION_DEFAULT_LIMIT));
  });

  routes.post("/read-all", (c) => c.json({ updated: deps.service.markAllRead() }));

  routes.post("/test-email", async (c) => {
    if (deps.mailer === null) {
      return c.json({ error: "SMTP is not configured", code: "smtp_not_configured" }, 409);
    }
    const { notificationEmail, locale } = deps.settings.get();
    if (notificationEmail === null) {
      return c.json(
        { error: "No notification email address is set", code: "recipient_missing" },
        409,
      );
    }
    const { subject, text } = renderEmail({
      event: "test",
      locale,
      panelUrl: panelUrlFor(deps.publicUrl, "/settings"),
    });
    try {
      await deps.mailer.send({ to: notificationEmail, subject, text });
    } catch {
      // The server's answer can hold addresses or account names: never echo it.
      return c.json({ error: "The mail server refused the message", code: "smtp_failed" }, 502);
    }
    const body: TestEmailResponse = { sent: true };
    return c.json(body, 202);
  });

  routes.post("/:notificationId/read", (c) => {
    const raw = c.req.param("notificationId");
    const id = /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
    if (id === 0 || !deps.service.markRead(id)) return c.json({ error: "Not found" }, 404);
    return c.body(null, 204);
  });

  return routes;
}
