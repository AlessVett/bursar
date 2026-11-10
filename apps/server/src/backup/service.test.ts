import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ServerEvent } from "@bursar/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog } from "../audit";
import { EventBus } from "../events/bus";
import { JobQueue, type JobRecord } from "../jobs/queue";
import { BACKUP_DEDUPE_KEY, BACKUP_JOB } from "../jobs/types";
import { PermanentJobError } from "../jobs/worker";
import { NotificationService } from "../notifications/service";
import { SettingsStore } from "../settings/store";
import { createKeyedTestDatabase, type KeyedTestDatabase, seedBackupRows } from "../test/backup";
import { createFakeS3, type FakeS3 } from "../test/fake-s3";
import { listBackupSets } from "./backup";
import { LocalDirStore } from "./object-store";
import { S3Store } from "./s3-store";
import { BACKUP_WORK_DIR, BackupInProgressError, BackupService } from "./service";
import { backupJobHandler, backupTask } from "./task";

const S3_SECRET = "s3-secret-access-key-value-0123456789";
/** 03:00 in Rome (CET) on 2026-11-09. */
const START = Date.parse("2026-11-09T02:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Fixture {
  t: KeyedTestDatabase;
  clock: { now: number };
  queue: JobQueue;
  settings: SettingsStore;
  notifications: NotificationService;
  service: BackupService;
  events: ServerEvent[];
  local: LocalDirStore;
  s3: FakeS3 | null;
}

let current: Fixture | null = null;
afterEach(() => {
  current?.t.dispose();
  current = null;
});

function setup(options: { s3?: boolean } = {}): Fixture {
  const t = createKeyedTestDatabase();
  seedBackupRows(t.sqlite, START);
  const clock = { now: START };
  const now = () => clock.now;
  const queue = new JobQueue(t.sqlite, now);
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const settings = new SettingsStore(t.db, now);
  const notifications = new NotificationService({
    db: t.db,
    queue,
    bus,
    settings,
    emailEnabled: () => false,
    now,
  });
  const s3 = options.s3 ? createFakeS3() : null;
  const dir = path.join(t.dir, "backups");
  const service = new BackupService({
    sqlite: t.sqlite,
    db: t.db,
    masterKey: t.masterKey,
    config: { dir, s3: null },
    s3: s3
      ? new S3Store({
          endpoint: new URL("https://s3.example.test"),
          region: "auto",
          bucket: "bursar-backups",
          prefix: "bursar",
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: S3_SECRET,
          fetch: s3.fetch,
        })
      : null,
    notifications,
    bus,
    audit: new AuditLog(t.db, now),
    timezone: "Europe/Rome",
    now,
  });
  current = {
    t,
    clock,
    queue,
    settings,
    notifications,
    service,
    events,
    local: new LocalDirStore(dir),
    s3,
  };
  return current;
}

const auditRows = (t: KeyedTestDatabase) =>
  t.sqlite
    .prepare("SELECT actor, target, details FROM audit_log WHERE action = 'backup.run' ORDER BY id")
    .all() as { actor: string; target: string | null; details: string }[];

const backupFailing = (f: Fixture) =>
  f.notifications.list(50).items.filter((item) => item.event === "backup_failing");

describe("BackupService", () => {
  it("backs up to the local directory, records the run and announces it", async () => {
    const f = setup();
    const item = await f.service.run("manual");

    expect(item).toMatchObject({
      trigger: "manual",
      status: "succeeded",
      target: "local",
      setId: "20261109T020000Z",
      startedAt: START,
      finishedAt: START,
      errorMessage: null,
    });
    expect(item.sizeBytes).toBeGreaterThan(0);
    expect(await listBackupSets(f.local)).toEqual(["20261109T020000Z"]);
    expect(f.events).toContainEqual({ type: "backup.finished", status: "succeeded" });
    expect(auditRows(f.t)).toEqual([
      {
        actor: "user",
        target: "20261109T020000Z",
        details: JSON.stringify({
          status: "succeeded",
          trigger: "manual",
          target: "local",
          sizeBytes: item.sizeBytes,
        }),
      },
    ]);
    expect(f.service.status()).toEqual({
      target: "local",
      lastSuccessAt: START,
      consecutiveFailures: 0,
      runs: [item],
    });
  });

  it("writes every set to S3 too when a target is configured", async () => {
    const f = setup({ s3: true });
    const item = await f.service.run("scheduled");

    expect(item).toMatchObject({ status: "succeeded", target: "s3", trigger: "scheduled" });
    expect(f.service.target()).toBe("s3");
    expect([...(f.s3?.objects.keys() ?? [])].sort()).toEqual([
      "bursar/20261109T020000Z/bursar.db",
      "bursar/20261109T020000Z/manifest.json",
    ]);
    expect(await listBackupSets(f.local)).toEqual(["20261109T020000Z"]);
    expect(auditRows(f.t)[0]?.actor).toBe("system");
  });

  it("keeps the local copy and records a reduced error when S3 refuses the upload", async () => {
    const f = setup({ s3: true });
    f.s3?.failWith(403, "AccessDenied");
    const item = await f.service.run("manual");

    expect(item).toMatchObject({
      status: "failed",
      target: "s3",
      setId: "20261109T020000Z",
      errorMessage: "Upload failed for s3 (S3 put failed: HTTP 403 AccessDenied)",
    });
    expect(item.errorMessage).not.toContain(S3_SECRET);
    expect(await listBackupSets(f.local)).toEqual(["20261109T020000Z"]);
    expect(f.events).toContainEqual({ type: "backup.finished", status: "failed" });
    expect(f.service.status()).toMatchObject({ lastSuccessAt: null, consecutiveFailures: 1 });
    expect(backupFailing(f)).toEqual([]);
  });

  it("raises backup_failing once a day from the second consecutive failure", async () => {
    const f = setup({ s3: true });
    f.s3?.failWith(500, "InternalError");

    await f.service.run("scheduled");
    expect(backupFailing(f)).toHaveLength(0);
    f.clock.now += HOUR;
    await f.service.run("manual");
    expect(f.service.status().consecutiveFailures).toBe(2);
    expect(backupFailing(f)).toHaveLength(1);
    expect(backupFailing(f)[0]).toMatchObject({
      link: "/settings#backups",
      params: { failures: 2 },
    });
    f.clock.now += HOUR;
    await f.service.run("manual");
    expect(backupFailing(f)).toHaveLength(1); // same local day: deduplicated

    f.clock.now += DAY;
    await f.service.run("scheduled");
    expect(backupFailing(f)).toHaveLength(2); // a new local day

    f.s3?.recover();
    f.clock.now += HOUR;
    const ok = await f.service.run("manual");
    expect(ok.status).toBe("succeeded");
    expect(f.service.status()).toMatchObject({
      consecutiveFailures: 0,
      lastSuccessAt: f.clock.now,
    });
  });

  it("applies the 7/4/6 retention to every store after a successful run", async () => {
    const f = setup({ s3: true });
    for (const setId of ["20250105T020000Z", "20261108T020000Z"]) {
      await f.local.put(`${setId}/bursar.db`, Buffer.from("old"));
      await f.local.put(`${setId}/manifest.json`, Buffer.from("{}"));
      f.s3?.objects.set(`bursar/${setId}/bursar.db`, Buffer.from("old"));
      f.s3?.objects.set(`bursar/${setId}/manifest.json`, Buffer.from("{}"));
    }

    await f.service.run("scheduled");

    expect(await listBackupSets(f.local)).toEqual(["20261109T020000Z", "20261108T020000Z"]);
    expect([...(f.s3?.objects.keys() ?? [])].filter((k) => k.includes("2025"))).toEqual([]);
    expect(f.s3?.objects.has("bursar/20261108T020000Z/manifest.json")).toBe(true);
  });

  it("refuses a second run while one is in progress", async () => {
    const f = setup();
    const first = f.service.run("manual");
    expect(f.service.isRunning()).toBe(true);
    await expect(f.service.run("manual")).rejects.toBeInstanceOf(BackupInProgressError);
    await first;
    expect(f.service.isRunning()).toBe(false);
  });

  it("fails runs left running by a previous process and clears the work directory", () => {
    const f = setup();
    f.t.sqlite
      .prepare(
        "INSERT INTO backup_runs (trigger, status, target, started_at) VALUES ('scheduled', 'running', 'local', ?)",
      )
      .run(START - HOUR);
    const workDir = path.join(f.t.dir, "backups", BACKUP_WORK_DIR);
    mkdirSync(workDir, { recursive: true });
    writeFileSync(path.join(workDir, "20261109T010000Z-abc.db"), "partial copy");

    expect(f.service.failStaleRuns()).toBe(1);
    expect(f.service.status().runs[0]).toMatchObject({
      status: "failed",
      finishedAt: START,
      errorMessage: "Interrupted by a restart",
    });
    expect(existsSync(workDir)).toBe(false);
    expect(f.service.failStaleRuns()).toBe(0);
  });

  it("lists the most recent runs first, up to the limit", async () => {
    const f = setup();
    for (let i = 0; i < 3; i++) {
      await f.service.run("manual");
      f.clock.now += HOUR;
    }
    const { runs } = f.service.status(2);
    expect(runs.map((r) => r.startedAt)).toEqual([START + 2 * HOUR, START + HOUR]);
  });
});

describe("backupJobHandler", () => {
  const job = (payload: unknown): JobRecord => ({
    id: 1,
    type: BACKUP_JOB,
    payload,
    attempts: 1,
    maxAttempts: 1,
  });

  it("runs a backup with the trigger of the payload", async () => {
    const f = setup();
    await backupJobHandler(f.service)(job({ trigger: "manual" }));
    expect(f.service.status().runs[0]).toMatchObject({ trigger: "manual", status: "succeeded" });
  });

  it("fails permanently on an invalid payload or when a backup is already running", async () => {
    const f = setup();
    await expect(backupJobHandler(f.service)(job({ trigger: "cli" }))).rejects.toBeInstanceOf(
      PermanentJobError,
    );
    const first = f.service.run("manual");
    await expect(backupJobHandler(f.service)(job({ trigger: "scheduled" }))).rejects.toBeInstanceOf(
      PermanentJobError,
    );
    await first;
  });
});

describe("backupTask", () => {
  const jobs = (f: Fixture) =>
    f.t.sqlite
      .prepare(
        "SELECT id, type, payload, status, max_attempts AS maxAttempts FROM jobs ORDER BY id",
      )
      .all() as {
      id: number;
      type: string;
      payload: string;
      status: string;
      maxAttempts: number;
    }[];

  const tick = (f: Fixture, at: number) => {
    f.clock.now = at;
    return backupTask({
      queue: f.queue,
      settings: f.settings,
      db: f.t.db,
      timezone: "Europe/Rome",
    }).run(new Date(at));
  };

  /** Claims the queued job, runs it through the handler and completes it. */
  const work = async (f: Fixture) => {
    const claimed = f.queue.claimNext();
    if (!claimed) throw new Error("no job queued");
    await backupJobHandler(f.service)(claimed);
    f.queue.complete(claimed.id);
  };

  it("enqueues nothing before backupTime and one scheduled job at or after it", async () => {
    const f = setup();
    await tick(f, START - 60_000); // 02:59 in Rome
    expect(jobs(f)).toEqual([]);
    await tick(f, START); // 03:00
    expect(jobs(f)).toEqual([
      {
        id: 1,
        type: BACKUP_JOB,
        payload: '{"trigger":"scheduled"}',
        status: "queued",
        maxAttempts: 1,
      },
    ]);
    expect(f.queue.findActive(BACKUP_DEDUPE_KEY)).toMatchObject({ status: "queued" });
  });

  it("enqueues once per local day, even when that day's run failed", async () => {
    const f = setup();
    await tick(f, START);
    await tick(f, START + 60_000);
    expect(jobs(f)).toHaveLength(1); // still active
    await work(f);
    await tick(f, START + 2 * 60_000);
    expect(jobs(f)).toHaveLength(1); // a scheduled run started today

    f.t.sqlite.exec("DELETE FROM backup_runs");
    f.t.sqlite
      .prepare(
        "INSERT INTO backup_runs (trigger, status, target, started_at, finished_at) VALUES ('scheduled', 'failed', 'local', ?, ?)",
      )
      .run(START, START);
    await tick(f, START + 3 * 60_000);
    expect(jobs(f)).toHaveLength(1); // failed today: retried the next night

    await tick(f, START + DAY);
    expect(jobs(f)).toHaveLength(2);
  });

  it("ignores manual runs when deciding whether tonight's backup ran", async () => {
    const f = setup();
    f.clock.now = START - 2 * HOUR;
    await f.service.run("manual");
    await tick(f, START);
    expect(jobs(f)).toHaveLength(1);
  });

  it("follows the configured backupTime in the configured time zone", async () => {
    const f = setup();
    f.settings.update({ backupTime: "23:30" });
    await tick(f, Date.parse("2026-11-09T22:00:00Z")); // 23:00 in Rome
    expect(jobs(f)).toHaveLength(0);
    await tick(f, Date.parse("2026-11-09T22:30:00Z")); // 23:30 in Rome
    expect(jobs(f)).toHaveLength(1);
  });
});
