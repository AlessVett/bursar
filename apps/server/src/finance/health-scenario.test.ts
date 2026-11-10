import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYNC_ACCOUNT_JOB } from "../jobs/types";
import { JobWorker } from "../jobs/worker";
import {
  createSyncHarness,
  DAY_MS,
  ebError,
  insertAccount,
  insertConnection,
  SYNC_TEST_NOW,
  SYNC_TEST_TIMEZONE,
  type SyncHarness,
} from "../test/sync-fixture";
import { syncHealthTask } from "./health-task";
import { homeSummary, type QueryDeps } from "./queries";
import { runAccountSync, syncAccountHandler } from "./sync";
import { dailySyncTask } from "./sync-task";

/**
 * Days of a bank outage through the real queue, worker, sync handler, daily task, health task and
 * Home summary, with the default background cap of 2 (spec §6.9: "sync failing for more than 2
 * days").
 */

const MINUTE_MS = 60_000;

let h: SyncHarness;
let accountId: number;
let worker: JobWorker;

beforeEach(async () => {
  h = createSyncHarness();
  const connectionId = insertConnection(h.t.sqlite, { now: h.clock.now });
  accountId = insertAccount(h.t.sqlite, { connectionId, now: h.clock.now });
  worker = new JobWorker(
    h.queue,
    new Map([[SYNC_ACCOUNT_JOB, syncAccountHandler(h.deps)]]),
    pino({ level: "silent" }),
  );
  // The last success: the initial sync on Monday 9 November at 10:00.
  expect(
    (await runAccountSync(h.deps, { accountId, trigger: "initial" }, { number: 1, max: 3 })).status,
  ).toBe("succeeded");
});
afterEach(() => h.dispose());

function queryDeps(): QueryDeps {
  return {
    db: h.t.db,
    sqlite: h.t.sqlite,
    queue: h.queue,
    timezone: SYNC_TEST_TIMEZONE,
    now: () => h.clock.now,
    locale: () => "en",
  };
}

/** One day later at the same time: the daily task queues, the worker drains, the health task runs. */
async function nextDay(): Promise<void> {
  h.clock.now += DAY_MS;
  const logger = pino({ level: "silent" });
  dailySyncTask({
    repo: h.repo,
    queue: h.queue,
    settings: h.settings,
    timezone: SYNC_TEST_TIMEZONE,
    logger,
  }).run(new Date(h.clock.now));
  // Enough steps for one run and both retries (30 s and 2 min backoff).
  for (let step = 0; step < 5; step += 1) {
    await worker.runOnce();
    h.clock.now += 3 * MINUTE_MS;
  }
  await syncHealthTask({
    repo: h.repo,
    notifications: h.notifications,
    settings: h.settings,
    timezone: SYNC_TEST_TIMEZONE,
    now: () => h.clock.now,
  }).run(new Date(h.clock.now));
}

const failingNotifications = () =>
  h.notifications.list(20).items.filter((item) => item.event === "sync_failing");
const failingAlerts = () =>
  homeSummary(queryDeps(), { target: "s3", consecutiveFailures: 0 }).alerts.filter(
    (alert) => alert.kind === "sync_failing",
  );
const newestRun = () => {
  const [run] = h.repo.listSyncRuns(accountId, 1);
  return run ? [run.status, run.skipReason ?? run.errorCode] : null;
};

describe("sync health over a bank outage", () => {
  it("warns once when every attempt fails and the cap refuses the last retry each day", async () => {
    expect(h.settings.get().backgroundSyncCap).toBe(2);
    for (let call = 0; call < 20; call += 1) {
      h.bank.balanceErrors.push(ebError(503, "ASPSP_ERROR", "The bank is unavailable"));
    }

    await nextDay();
    // Two charged attempts failed; the third was refused by the cap and completed the job.
    expect(newestRun()).toEqual(["skipped", "daily_cap"]);
    expect(failingNotifications()).toEqual([]);
    expect(failingAlerts()).toEqual([]);

    await nextDay();
    await nextDay();
    expect(newestRun()).toEqual(["skipped", "daily_cap"]);
    expect(h.bank.balanceCalls).toHaveLength(1 + 3 * 2);
    expect(failingNotifications().map((item) => item.link)).toEqual([`/accounts/${accountId}`]);
    expect(failingAlerts()).toEqual([
      expect.objectContaining({ kind: "sync_failing", accountId, since: SYNC_TEST_NOW }),
    ]);
  });

  it("warns when the bank answers with a rate limit every day", async () => {
    for (let call = 0; call < 5; call += 1) {
      h.bank.balanceErrors.push(
        ebError(429, "ASPSP_RATE_LIMIT_EXCEEDED", "The bank rate limit was exceeded"),
      );
    }

    await nextDay();
    expect(newestRun()).toEqual(["skipped", "rate_limited"]);
    expect(failingNotifications()).toEqual([]);

    await nextDay();
    await nextDay();
    expect(newestRun()).toEqual(["skipped", "rate_limited"]);
    expect(h.bank.balanceCalls).toHaveLength(1 + 3);
    expect(failingNotifications()).toHaveLength(1);
    expect(failingAlerts()).toEqual([
      expect.objectContaining({ kind: "sync_failing", accountId, since: SYNC_TEST_NOW }),
    ]);
  });

  it("warns about an account the bank reported unavailable, although it is no longer synced", async () => {
    h.bank.balanceErrors.push(
      ebError(404, "ASPSP_ACCOUNT_NOT_ACCESSIBLE", "The account is not accessible"),
    );

    await nextDay();
    expect(h.repo.getAccount(accountId)?.status).toBe("unavailable");
    expect(failingNotifications()).toEqual([]);

    await nextDay();
    await nextDay();
    // Not queued again by the daily task: only the initial sync and the failing day reached the bank.
    expect(h.bank.balanceCalls).toHaveLength(2);
    expect(failingNotifications()).toHaveLength(1);
    expect(failingAlerts()).toEqual([
      expect.objectContaining({ kind: "sync_failing", accountId, since: SYNC_TEST_NOW }),
    ]);
  });

  it("stays quiet when the bank recovers within two days", async () => {
    h.bank.balanceErrors.push(
      ebError(503, "ASPSP_ERROR", "The bank is unavailable"),
      ebError(503, "ASPSP_ERROR", "The bank is unavailable"),
    );

    await nextDay();
    await nextDay();
    await nextDay();
    expect(newestRun()).toEqual(["succeeded", null]);
    expect(failingNotifications()).toEqual([]);
    expect(failingAlerts()).toEqual([]);
  });
});
