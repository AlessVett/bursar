import path from "node:path";
import { backupStatusResponseSchema } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../audit";
import { EventBus } from "../events/bus";
import { JobQueue } from "../jobs/queue";
import { BACKUP_DEDUPE_KEY } from "../jobs/types";
import { NotificationService } from "../notifications/service";
import { SettingsStore } from "../settings/store";
import { createTestApp, type TestApp } from "../test/app";
import { createKeyedTestDatabase, type KeyedTestDatabase } from "../test/backup";
import { backupRoutes } from "./routes";
import { BackupService } from "./service";

describe("/api/backups", () => {
  let t: KeyedTestDatabase;
  let queue: JobQueue;
  let service: BackupService;
  let api: TestApp;

  beforeEach(async () => {
    t = createKeyedTestDatabase();
    queue = new JobQueue(t.sqlite);
    const bus = new EventBus();
    const settings = new SettingsStore(t.db);
    service = new BackupService({
      sqlite: t.sqlite,
      db: t.db,
      masterKey: t.masterKey,
      config: { dir: path.join(t.dir, "backups"), s3: null },
      notifications: new NotificationService({
        db: t.db,
        queue,
        bus,
        settings,
        emailEnabled: () => false,
      }),
      bus,
      audit: new AuditLog(t.db),
      timezone: "Europe/Rome",
    });
    api = await createTestApp({
      database: t,
      routers: [{ prefix: "/api/backups", router: backupRoutes({ service, queue }) }],
    });
  });
  afterEach(() => t.dispose());

  it("returns the status: target, last success, failures and recent runs", async () => {
    const empty = await api.json("/api/backups");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(empty.body).toEqual({
      target: "local",
      lastSuccessAt: null,
      consecutiveFailures: 0,
      runs: [],
    });

    const run = await service.run("manual");
    const after = await api.json("/api/backups");
    const body = backupStatusResponseSchema.parse(after.body);
    expect(body.runs).toEqual([run]);
    expect(body.lastSuccessAt).toBe(run.finishedAt);
  });

  it("queues a manual backup once and answers 409 while it is queued", async () => {
    const first = await api.json("/api/backups/run", { method: "POST" });
    expect(first).toMatchObject({ status: 202, body: { queued: true } });
    const job = t.sqlite
      .prepare("SELECT type, payload, max_attempts AS maxAttempts FROM jobs")
      .get();
    expect(job).toEqual({ type: "backup.run", payload: '{"trigger":"manual"}', maxAttempts: 1 });
    expect(queue.findActive(BACKUP_DEDUPE_KEY)).not.toBeNull();

    const second = await api.json("/api/backups/run", { method: "POST" });
    expect(second).toMatchObject({
      status: 409,
      body: { error: "A backup is already running", code: "backup_in_progress" },
    });
  });

  it("answers 409 while a backup runs in this process", async () => {
    const running = service.run("cli");
    const response = await api.json("/api/backups/run", { method: "POST" });
    expect(response).toMatchObject({ status: 409, body: { code: "backup_in_progress" } });
    await running;
    expect((await api.json("/api/backups/run", { method: "POST" })).status).toBe(202);
  });

  it("requires a session and a same-origin POST", async () => {
    expect((await api.app.request("/api/backups")).status).toBe(401);
    const crossSite = await api.app.request("/api/backups/run", {
      method: "POST",
      headers: { cookie: api.cookie, origin: "https://elsewhere.example.test" },
    });
    expect(crossSite.status).toBe(403);
  });
});
