import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobQueue } from "../jobs/queue";
import { syncDedupeKey } from "../jobs/types";
import type { ScheduledTask } from "../scheduler";
import { SettingsStore } from "../settings/store";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { DAY_MS, insertAccount, insertConnection, SYNC_TEST_TIMEZONE } from "../test/sync-fixture";
import { FinanceRepository } from "./repository";
import { dailySyncTask } from "./sync-task";

/** A wall-clock time in Rome during November 2026 (UTC+1). */
function rome(day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 10, day, hour - 1, minute));
}

describe("dailySyncTask", () => {
  let t: TestDatabase;
  let clock: { now: number };
  let repo: FinanceRepository;
  let queue: JobQueue;
  let settings: SettingsStore;
  let task: ScheduledTask;
  const ids = {
    syncable: 0,
    disabled: 0,
    noUid: 0,
    paused: 0,
    expiring: 0,
    expired: 0,
    removed: 0,
    revoked: 0,
  };

  beforeEach(() => {
    t = createTestDatabase();
    clock = { now: rome(1, 12, 0).getTime() };
    const now = () => clock.now;
    repo = new FinanceRepository(t.db, now);
    queue = new JobQueue(t.sqlite, now);
    settings = new SettingsStore(t.db, now);
    task = dailySyncTask({
      repo,
      queue,
      settings,
      timezone: SYNC_TEST_TIMEZONE,
      logger: pino({ level: "silent" }),
    });

    const created = clock.now;
    const active = insertConnection(t.sqlite, { now: created, validUntil: created + 120 * DAY_MS });
    ids.syncable = insertAccount(t.sqlite, { connectionId: active, now: created });
    ids.disabled = insertAccount(t.sqlite, {
      connectionId: active,
      now: created,
      status: "disabled",
    });
    ids.noUid = insertAccount(t.sqlite, {
      connectionId: active,
      now: created,
      providerAccountUid: null,
    });
    ids.paused = insertAccount(t.sqlite, {
      connectionId: active,
      now: created,
      rateLimitedUntil: rome(9, 8, 0).getTime(),
    });
    const expiring = insertConnection(t.sqlite, {
      now: created,
      validUntil: rome(14, 12, 0).getTime(),
    });
    ids.expiring = insertAccount(t.sqlite, { connectionId: expiring, now: created });
    const expired = insertConnection(t.sqlite, {
      now: created,
      validUntil: rome(8, 12, 0).getTime(),
    });
    ids.expired = insertAccount(t.sqlite, { connectionId: expired, now: created });
    const removed = insertConnection(t.sqlite, { now: created, removedAt: created });
    ids.removed = insertAccount(t.sqlite, { connectionId: removed, now: created });
    const revoked = insertConnection(t.sqlite, { now: created, status: "revoked" });
    ids.revoked = insertAccount(t.sqlite, { connectionId: revoked, now: created });
  });
  afterEach(() => t.dispose());

  async function tick(at: Date): Promise<void> {
    clock.now = at.getTime();
    await task.run(at);
  }

  function queuedKeys(): Set<string> {
    return queue.activeKeys("sync:");
  }

  /** Completes every queued job and returns the payloads in queue order. */
  function drain(): unknown[] {
    const payloads: unknown[] = [];
    for (let job = queue.claimNext(); job !== null; job = queue.claimNext()) {
      payloads.push(job.payload);
      queue.complete(job.id);
    }
    return payloads;
  }

  it("is named bank-daily-sync", () => {
    expect(task.name).toBe("bank-daily-sync");
  });

  it("does nothing before the configured time", async () => {
    await tick(rome(9, 5, 59));
    expect(queuedKeys().size).toBe(0);
  });

  it("queues one background sync per eligible account at the configured time and marks the day", async () => {
    await tick(rome(9, 6, 0));
    expect(queuedKeys()).toEqual(
      new Set([syncDedupeKey(ids.syncable), syncDedupeKey(ids.expiring)]),
    );
    expect(drain()).toEqual([
      { accountId: ids.syncable, trigger: "background" },
      { accountId: ids.expiring, trigger: "background" },
    ]);
    expect(repo.getAccount(ids.syncable)?.lastScheduledSyncDay).toBe("2026-11-09");
    expect(repo.getAccount(ids.paused)?.lastScheduledSyncDay).toBeNull();
    expect(repo.getAccount(ids.expired)?.lastScheduledSyncDay).toBeNull();
  });

  it("queues nothing more on later ticks of the same day", async () => {
    await tick(rome(9, 6, 0));
    drain();
    await tick(rome(9, 6, 1));
    await tick(rome(9, 7, 30));
    expect(queuedKeys().size).toBe(0);
  });

  it("picks up a paused account once its pause ends", async () => {
    await tick(rome(9, 6, 0));
    drain();
    await tick(rome(9, 8, 1));
    expect(queuedKeys()).toEqual(new Set([syncDedupeKey(ids.paused)]));
  });

  it("runs again on the next local day", async () => {
    await tick(rome(9, 6, 0));
    drain();
    await tick(rome(10, 5, 59));
    expect(queuedKeys().size).toBe(0);
    await tick(rome(10, 6, 0));
    expect(queuedKeys()).toEqual(
      new Set([
        syncDedupeKey(ids.syncable),
        syncDedupeKey(ids.paused),
        syncDedupeKey(ids.expiring),
      ]),
    );
  });

  it("honours a custom daily sync time", async () => {
    settings.update({ dailySyncTime: "21:30" });
    await tick(rome(9, 21, 29));
    expect(queuedKeys().size).toBe(0);
    await tick(rome(9, 21, 30));
    expect(queuedKeys()).toEqual(
      new Set([
        syncDedupeKey(ids.syncable),
        syncDedupeKey(ids.paused),
        syncDedupeKey(ids.expiring),
      ]),
    );
  });
});
