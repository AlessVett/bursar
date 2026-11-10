import { notificationListResponseSchema } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test/app";
import {
  createNotificationFixture,
  type NotificationFixture,
  TEST_PUBLIC_URL,
  TEST_RECIPIENT,
} from "../test/notifications";
import type { Mailer } from "./mailer";
import { notificationRoutes } from "./routes";
import { renderEmail } from "./templates";

describe("notification routes", () => {
  let f: NotificationFixture;

  const mount = (mailer: Mailer | null = f.mailer): Promise<TestApp> =>
    createTestApp({
      database: f.t,
      routers: [
        {
          prefix: "/api/notifications",
          router: notificationRoutes({
            service: f.service,
            mailer,
            settings: f.settings,
            publicUrl: TEST_PUBLIC_URL,
          }),
        },
      ],
    });

  /** A 204 has no body, so this goes through the raw app instead of `json()`. */
  const markRead = (app: TestApp, id: number): Promise<Response> =>
    Promise.resolve(
      app.app.request(`/api/notifications/${id}/read`, {
        method: "POST",
        headers: { origin: app.origin, cookie: app.cookie },
      }),
    );

  const raiseMany = (count: number) => {
    for (let n = 1; n <= count; n += 1) {
      f.clock.now += 1_000;
      f.service.raise({
        event: "sync_failing",
        dedupeKey: `sync-failing:${n}:never`,
        params: { accountName: `Account ${n}` },
        link: `/accounts/${n}`,
      });
    }
  };

  beforeEach(() => {
    f = createNotificationFixture();
  });
  afterEach(() => f.dispose());

  it("requires a session", async () => {
    const { app } = await mount();
    const response = await app.request("/api/notifications");
    expect(response.status).toBe(401);
  });

  it("lists the newest six by default with the unread count", async () => {
    const app = await mount();
    raiseMany(8);
    const response = await app.json("/api/notifications");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = notificationListResponseSchema.parse(response.body);
    expect(body.unread).toBe(8);
    expect(body.items).toHaveLength(6);
    expect(body.items[0]).toMatchObject({
      event: "sync_failing",
      params: { accountName: "Account 8" },
      link: "/accounts/8",
      readAt: null,
    });
  });

  it("honours the limit and rejects values outside 1 to 50", async () => {
    const app = await mount();
    raiseMany(4);
    const two = notificationListResponseSchema.parse(
      (await app.json("/api/notifications?limit=2")).body,
    );
    expect(two.items).toHaveLength(2);
    expect(two.unread).toBe(4);
    for (const limit of ["0", "51", "abc", "-1", "2.5"]) {
      const response = await app.json(`/api/notifications?limit=${limit}`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid request" });
    }
  });

  it("marks one notification read", async () => {
    const app = await mount();
    raiseMany(2);
    const first = notificationListResponseSchema.parse((await app.json("/api/notifications")).body)
      .items[0];
    const response = await markRead(app, first?.id ?? 0);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const after = notificationListResponseSchema.parse((await app.json("/api/notifications")).body);
    expect(after.unread).toBe(1);
    expect(after.items.find((item) => item.id === first?.id)?.readAt).not.toBeNull();
    expect((await markRead(app, first?.id ?? 0)).status).toBe(204);
  });

  it("answers 404 for an unknown or malformed id, without echoing it", async () => {
    const app = await mount();
    for (const id of ["999", "0", "abc", "1.5", "-3"]) {
      const response = await app.json(`/api/notifications/${id}/read`, { method: "POST" });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Not found" });
    }
  });

  it("marks everything read", async () => {
    const app = await mount();
    raiseMany(3);
    expect((await app.json("/api/notifications/read-all", { method: "POST" })).body).toEqual({
      updated: 3,
    });
    expect((await app.json("/api/notifications/read-all", { method: "POST" })).body).toEqual({
      updated: 0,
    });
    expect(
      notificationListResponseSchema.parse((await app.json("/api/notifications")).body).unread,
    ).toBe(0);
  });

  describe("POST /test-email", () => {
    it("sends a test message to the notification address in the configured language", async () => {
      const app = await mount();
      f.settings.update({ locale: "en" });
      const response = await app.json("/api/notifications/test-email", { method: "POST" });
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ sent: true });
      expect(f.mailer.sent).toEqual([
        {
          to: TEST_RECIPIENT,
          ...renderEmail({
            event: "test",
            locale: "en",
            panelUrl: "https://bursar.example.test/settings",
          }),
        },
      ]);
    });

    it("answers 409 smtp_not_configured when there is no mailer", async () => {
      const app = await mount(null);
      const response = await app.json("/api/notifications/test-email", { method: "POST" });
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "SMTP is not configured",
        code: "smtp_not_configured",
      });
    });

    it("answers 409 recipient_missing when no address is set", async () => {
      const app = await mount();
      f.settings.update({ notificationEmail: null });
      const response = await app.json("/api/notifications/test-email", { method: "POST" });
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: "No notification email address is set",
        code: "recipient_missing",
      });
      expect(f.mailer.sent).toHaveLength(0);
    });

    it("answers 502 smtp_failed without the server's error text", async () => {
      const app = await mount();
      f.mailer.failNext = Object.assign(
        new Error("535 5.7.8 Authentication failed for bursar-user: password hunter2"),
        { code: "EAUTH", responseCode: 535 },
      );
      const response = await app.json("/api/notifications/test-email", { method: "POST" });
      expect(response.status).toBe(502);
      expect(response.body).toEqual({
        error: "The mail server refused the message",
        code: "smtp_failed",
      });
      const serialised = JSON.stringify(response.body);
      for (const leaked of ["535", "hunter2", "bursar-user", "EAUTH"]) {
        expect(serialised).not.toContain(leaked);
      }
    });
  });
});
