import { SETTINGS_DEFAULTS, type ServerEvent, type SettingsResponse } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../audit";
import { EventBus } from "../events/bus";
import { createTestApp, type TestApp } from "../test/app";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { settingsRoutes } from "./routes";
import { SettingsStore } from "./store";

const SYSTEM: SettingsResponse["system"] = {
  timezone: "Europe/Rome",
  publicUrl: "https://bursar.example.test",
  enableBankingConfigured: true,
  smtpConfigured: false,
  backupTarget: "local",
};

describe("settings routes", () => {
  let t: TestDatabase;
  let now: number;
  let app: TestApp;
  let events: ServerEvent[];

  const auditRows = () =>
    t.sqlite
      .prepare("SELECT actor, action, target, details, at FROM audit_log ORDER BY id")
      .all() as {
      actor: string;
      action: string;
      target: string | null;
      details: string | null;
      at: number;
    }[];
  const patch = (body: unknown) => app.json("/api/settings", { method: "PATCH", body });

  beforeEach(async () => {
    t = createTestDatabase();
    now = Date.UTC(2026, 10, 9, 9, 0, 0);
    events = [];
    const bus = new EventBus();
    bus.subscribe((event) => events.push(event));
    app = await createTestApp({
      database: t,
      now: () => now,
      routers: [
        {
          prefix: "/api/settings",
          router: settingsRoutes({
            store: new SettingsStore(t.db, () => now),
            audit: new AuditLog(t.db, () => now),
            bus,
            system: SYSTEM,
          }),
        },
      ],
    });
  });
  afterEach(() => t.dispose());

  it("requires a session", async () => {
    const get = await app.app.request("/api/settings");
    expect(get.status).toBe(401);
    const patched = await app.app.request("/api/settings", {
      method: "PATCH",
      headers: { origin: app.origin, "content-type": "application/json" },
      body: JSON.stringify({ consentDays: 90 }),
    });
    expect(patched.status).toBe(401);
    expect(auditRows()).toEqual([]);
  });

  it("returns the defaults and the system facts", async () => {
    const res = await app.json("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ values: SETTINGS_DEFAULTS, system: SYSTEM });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("applies a partial update and returns the whole document", async () => {
    const res = await patch({
      consentDays: 90,
      locale: "en",
      notificationEmail: "owner@example.test",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      values: {
        ...SETTINGS_DEFAULTS,
        consentDays: 90,
        locale: "en",
        notificationEmail: "owner@example.test",
      },
      system: SYSTEM,
    });
    expect(((await app.json("/api/settings")).body as SettingsResponse).values.consentDays).toBe(
      90,
    );
  });

  it("audits the key names only and publishes settings.updated", async () => {
    await patch({ notificationEmail: "owner@example.test", dailySyncTime: "07:15" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      actor: "user",
      action: "settings.update",
      target: "settings",
      details: JSON.stringify({ keys: "dailySyncTime,notificationEmail" }),
      at: now,
    });
    expect(JSON.stringify(rows)).not.toContain("owner@example.test");
    expect(JSON.stringify(rows)).not.toContain("07:15");
    expect(events).toEqual([{ type: "settings.updated" }]);
  });

  it("does not audit or publish when nothing changes", async () => {
    expect((await patch({})).status).toBe(200);
    expect((await patch({ consentDays: 180, country: null })).status).toBe(200);
    expect(auditRows()).toEqual([]);
    expect(events).toEqual([]);
  });

  it.each([
    ["an unknown key", { consentdays: 90 }],
    ["an unknown key next to a valid one", { consentDays: 90, extra: 1 }],
    ["a malformed time", { dailySyncTime: "6am" }],
    ["an out-of-range time", { backupTime: "24:00" }],
    ["a malformed email", { notificationEmail: "owner" }],
    ["a background cap of 5", { backgroundSyncCap: 5 }],
    ["a background cap of 0", { backgroundSyncCap: 0 }],
    ["consent days beyond a year", { consentDays: 366 }],
    ["a lowercase country", { country: "it" }],
    ["an unsupported locale", { locale: "de" }],
    ["a string boolean", { emailNotifications: "true" }],
    ["an array body", [{ consentDays: 90 }]],
    ["a null body", null],
  ])("rejects %s with 400 invalid_settings and changes nothing", async (_name, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid settings", code: "invalid_settings" });
    expect((await app.json("/api/settings")).body).toEqual({
      values: SETTINGS_DEFAULTS,
      system: SYSTEM,
    });
    expect(auditRows()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await app.app.request("/api/settings", {
      method: "PATCH",
      headers: { origin: app.origin, "content-type": "application/json", cookie: app.cookie },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid settings", code: "invalid_settings" });
  });

  it("keeps the Origin check on PATCH", async () => {
    const res = await app.app.request("/api/settings", {
      method: "PATCH",
      headers: {
        origin: "https://attacker.example.test",
        "content-type": "application/json",
        cookie: app.cookie,
      },
      body: JSON.stringify({ consentDays: 90 }),
    });
    expect(res.status).toBe(403);
    expect(auditRows()).toEqual([]);
  });

  it("reads settings changed through the store directly", async () => {
    new SettingsStore(t.db, () => now).update({ highlightNegativeNet: false });
    expect(
      ((await app.json("/api/settings")).body as SettingsResponse).values.highlightNegativeNet,
    ).toBe(false);
  });
});
