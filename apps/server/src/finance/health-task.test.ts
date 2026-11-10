import { accountDisplayName } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BANK_NAME,
  createLifecycleFixture,
  DAY_MS,
  HOUR_MS,
  insertAccount,
  insertConnection,
  insertSyncRun,
  type LifecycleFixture,
  NOW,
  notificationRows,
  TIMEZONE,
} from "../test/lifecycle";
import { SYNC_FAILING_AFTER_MS, syncHealthTask } from "./health-task";

let fx: LifecycleFixture;
let connectionId: number;

beforeEach(() => {
  fx = createLifecycleFixture();
  connectionId = insertConnection(fx, { validUntil: NOW + 90 * DAY_MS });
});
afterEach(() => fx.dispose());

const makeTask = () =>
  syncHealthTask({
    repo: fx.repo,
    notifications: fx.service,
    settings: fx.settings,
    timezone: TIMEZONE,
    now: () => fx.clock.now,
  });

async function tick(): Promise<void> {
  await makeTask().run(new Date(fx.clock.now));
}

const failingRows = () => notificationRows(fx).filter((row) => row.event === "sync_failing");

/** A failed attempt as `finishRun` records it: the run row plus the account's sync error. */
function failAttempt(accountId: number, startedAt: number, code = "ASPSP_ERROR"): void {
  insertSyncRun(fx, accountId, "failed", startedAt, code);
  fx.repo.updateAccount(accountId, { lastSyncErrorCode: code, lastSyncErrorAt: startedAt + 1_000 });
}

/** A successful run as `finishRun` records it: the sync time is set and the error cleared. */
function succeed(accountId: number, startedAt: number): void {
  insertSyncRun(fx, accountId, "succeeded", startedAt);
  fx.repo.updateAccount(accountId, {
    lastSyncedAt: startedAt + 1_000,
    lastSyncErrorCode: null,
    lastSyncErrorAt: null,
  });
}

describe("syncHealthTask", () => {
  it("is the sync-health task with a 48 hour threshold", () => {
    expect(makeTask().name).toBe("sync-health");
    expect(SYNC_FAILING_AFTER_MS).toBe(48 * HOUR_MS);
  });

  it("warns about an account that never synced 48 hours after it was added", async () => {
    const id = insertAccount(fx, connectionId, {
      nickname: "Conto spese",
      createdAt: NOW - 49 * HOUR_MS,
    });
    failAttempt(id, NOW - HOUR_MS);
    await tick();
    expect(failingRows()).toEqual([
      {
        event: "sync_failing",
        dedupeKey: `sync-failing:${id}:never`,
        params: { accountName: "Conto spese", bankName: BANK_NAME },
        link: `/accounts/${id}`,
      },
    ]);
  });

  it("waits until 48 hours have passed", async () => {
    const fresh = insertAccount(fx, connectionId, { createdAt: NOW - 47 * HOUR_MS });
    const recent = insertAccount(fx, connectionId, {
      createdAt: NOW - 30 * DAY_MS,
      lastSyncedAt: NOW - 47 * HOUR_MS,
    });
    failAttempt(fresh, NOW - HOUR_MS);
    failAttempt(recent, NOW - HOUR_MS);
    await tick();
    expect(failingRows()).toEqual([]);
  });

  it("keys the warning by the local date of the last success", async () => {
    const lastSyncedAt = Date.UTC(2026, 10, 6, 23, 30); // 7 November, 00:30 in Rome
    const id = insertAccount(fx, connectionId, { createdAt: NOW - 30 * DAY_MS });
    succeed(id, lastSyncedAt - 1_000);
    failAttempt(id, NOW - 2 * HOUR_MS);
    await tick();
    expect(failingRows().map((row) => row.dedupeKey)).toEqual([`sync-failing:${id}:2026-11-07`]);
  });

  it("raises when the background cap refused the last retry of a failing day", async () => {
    // Cap 2: the first two attempts fail and the third is refused as `daily_cap`.
    const id = insertAccount(fx, connectionId, { createdAt: NOW - 30 * DAY_MS });
    succeed(id, NOW - 3 * DAY_MS);
    failAttempt(id, NOW - 3 * HOUR_MS);
    failAttempt(id, NOW - 3 * HOUR_MS + 30_000);
    insertSyncRun(fx, id, "skipped", NOW - 3 * HOUR_MS + 150_000, null, "daily_cap");
    await tick();
    expect(failingRows().map((row) => row.dedupeKey)).toEqual([`sync-failing:${id}:2026-11-06`]);
  });

  it("raises when the bank keeps answering with a rate limit", async () => {
    const id = insertAccount(fx, connectionId, { createdAt: NOW - 30 * DAY_MS });
    succeed(id, NOW - 3 * DAY_MS);
    for (const at of [NOW - 2 * DAY_MS, NOW - DAY_MS, NOW - HOUR_MS]) {
      insertSyncRun(fx, id, "skipped", at, "ASPSP_RATE_LIMIT_EXCEEDED", "rate_limited");
      fx.repo.updateAccount(id, {
        lastSyncErrorCode: "ASPSP_RATE_LIMIT_EXCEEDED",
        lastSyncErrorAt: at + 1_000,
        rateLimitedUntil: at + 6 * HOUR_MS,
      });
    }
    await tick();
    expect(failingRows().map((row) => row.dedupeKey)).toEqual([`sync-failing:${id}:2026-11-06`]);
  });

  it.each(["no attempt", "only daily_cap skips", "a sync in progress"] as const)(
    "stays quiet without a sync error after the last success (%s)",
    async (latest) => {
      const id = insertAccount(fx, connectionId, { createdAt: NOW - 30 * DAY_MS });
      succeed(id, NOW - 3 * DAY_MS);
      if (latest === "only daily_cap skips") {
        insertSyncRun(fx, id, "skipped", NOW - 2 * HOUR_MS, null, "daily_cap");
        insertSyncRun(fx, id, "skipped", NOW - HOUR_MS, null, "daily_cap");
      } else if (latest === "a sync in progress") {
        insertSyncRun(fx, id, "running", NOW - HOUR_MS);
      }
      await tick();
      expect(failingRows()).toEqual([]);
    },
  );

  it("stays quiet when the recorded error is older than the last success", async () => {
    insertAccount(fx, connectionId, {
      createdAt: NOW - 30 * DAY_MS,
      lastSyncedAt: NOW - 3 * DAY_MS,
      lastSyncErrorAt: NOW - 4 * DAY_MS,
    });
    await tick();
    expect(failingRows()).toEqual([]);
  });

  it("warns about an account the bank reported unavailable", async () => {
    const id = insertAccount(fx, connectionId, {
      createdAt: NOW - 30 * DAY_MS,
      nickname: "Conto carta",
      status: "unavailable",
    });
    succeed(id, NOW - 49 * HOUR_MS);
    failAttempt(id, NOW - 48 * HOUR_MS, "ASPSP_ACCOUNT_NOT_ACCESSIBLE");
    await tick();
    await tick();
    expect(failingRows()).toEqual([
      {
        event: "sync_failing",
        dedupeKey: `sync-failing:${id}:2026-11-07`,
        params: { accountName: "Conto carta", bankName: BANK_NAME },
        link: `/accounts/${id}`,
      },
    ]);
  });

  it("raises once per outage and again after a new success", async () => {
    const id = insertAccount(fx, connectionId, { createdAt: NOW - 30 * DAY_MS });
    succeed(id, NOW - 3 * DAY_MS - 1_000);
    failAttempt(id, NOW - HOUR_MS);
    await tick();
    await tick();
    expect(failingRows()).toHaveLength(1);

    succeed(id, NOW + HOUR_MS - 1_000);
    fx.clock.now += 3 * DAY_MS;
    failAttempt(id, fx.clock.now - HOUR_MS);
    await tick();
    expect(failingRows().map((row) => row.dedupeKey)).toEqual([
      `sync-failing:${id}:2026-11-06`,
      `sync-failing:${id}:2026-11-09`,
    ]);
  });

  it("ignores disabled and removed accounts and connections that cannot sync", async () => {
    const old = { createdAt: NOW - 30 * DAY_MS, lastSyncedAt: NOW - 5 * DAY_MS };
    const lapsed = insertConnection(fx, { validUntil: NOW - HOUR_MS });
    const revoked = insertConnection(fx, { validUntil: NOW + 90 * DAY_MS, status: "revoked" });
    const removed = insertConnection(fx, {
      validUntil: NOW + 90 * DAY_MS,
      removedAt: NOW - DAY_MS,
    });
    const ids = [
      insertAccount(fx, connectionId, { ...old, status: "disabled" }),
      insertAccount(fx, connectionId, { ...old, status: "removed", removedAt: NOW - DAY_MS }),
      insertAccount(fx, lapsed, old),
      insertAccount(fx, revoked, old),
      insertAccount(fx, removed, old),
      insertAccount(fx, lapsed, { ...old, status: "unavailable" }),
    ];
    for (const id of ids) failAttempt(id, NOW - HOUR_MS);
    await tick();
    expect(failingRows()).toEqual([]);
  });

  it("falls back to the account type and last digits, in the panel language", async () => {
    fx.settings.update({ locale: "en" });
    const id = insertAccount(fx, connectionId, {
      createdAt: NOW - 3 * DAY_MS,
      nickname: null,
      product: null,
      cashAccountType: "CACC",
      last4: "4821",
    });
    failAttempt(id, NOW - HOUR_MS);
    await tick();
    expect(failingRows()[0]?.params).toEqual({
      accountName: accountDisplayName(
        { nickname: null, product: null, details: null, cashAccountType: "CACC", last4: "4821" },
        "en",
      ),
      bankName: BANK_NAME,
    });
  });
});
