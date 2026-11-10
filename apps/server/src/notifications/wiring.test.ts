import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { type RunningBursar, startBursar } from "../server";
import { SettingsStore } from "../settings/store";
import { MIGRATIONS_DIR } from "../test/db";
import { notificationKeys } from "./keys";
import { MemoryMailer } from "./mailer";

describe("notifications in startBursar", () => {
  let dir: string;
  let running: RunningBursar[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-notify-"));
    running = [];
  });
  afterEach(async () => {
    for (const instance of running) await instance.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(overrides: Parameters<typeof startBursar>[2]): Promise<RunningBursar> {
    const config = loadConfig({
      BURSAR_PUBLIC_URL: "http://127.0.0.1",
      TZ: "UTC",
      BURSAR_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
      BURSAR_DATA_DIR: dir,
      BURSAR_MIGRATIONS_DIR: MIGRATIONS_DIR,
    });
    const instance = await startBursar(
      { ...config, port: 0 },
      pino({ level: "silent" }),
      overrides,
    );
    running.push(instance);
    return instance;
  }

  it("emails a raised notification through the injected mailer", async () => {
    const mailer = new MemoryMailer();
    const instance = await boot({
      mailer,
      seed: ({ db }) => {
        new SettingsStore(db).update({ notificationEmail: "owner@example.test" });
      },
    });
    const id = instance.notifications.raise({
      event: "backup_failing",
      dedupeKey: notificationKeys.backupFailing("2026-11-09"),
      params: { attempts: 2 },
      link: "/settings#backups",
    });
    expect(id).not.toBeNull();
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(1), { timeout: 10_000, interval: 100 });
    expect(mailer.sent[0]?.to).toBe("owner@example.test");
    expect(mailer.sent[0]?.subject).toMatch(/^Bursar: /);
    expect(mailer.sent[0]?.text).toContain("http://127.0.0.1/settings#backups");
  });

  it("keeps notifications panel-only when there is no mailer", async () => {
    const instance = await boot({
      mailer: null,
      seed: ({ db }) => {
        new SettingsStore(db).update({ notificationEmail: "owner@example.test" });
      },
    });
    const id = instance.notifications.raise({
      event: "consent_expired",
      dedupeKey: notificationKeys.consentExpired(1, 1_800_000_000_000),
      params: {},
      link: "/accounts",
    });
    expect(id).not.toBeNull();
    expect(instance.notifications.list(5).items).toHaveLength(1);
  });

  it("serves /api/notifications behind the session check", async () => {
    const instance = await boot({ mailer: null });
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/notifications`);
    expect(response.status).toBe(401);
  });
});
