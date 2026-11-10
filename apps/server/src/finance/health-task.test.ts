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
    insertSyncRun(fx, id, "failed", NOW - HOUR_MS, "ASPSP_ERROR");
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
    insertSyncRun(fx, fresh, "failed", NOW - HOUR_MS);
    insertSyncRun(fx, recent, "failed", NOW - HOUR_MS);
    await tick();
    expect(failingRows()).toEqual([]);
  });

  it("keys the warning by the local date of the last success", async () => {
    const lastSyncedAt = Date.UTC(2026, 10, 6, 23, 30); // 7 November, 00:30 in Rome
    const id = insertAccount(fx, connectionId, { createdAt: NOW - 30 * DAY_MS, lastSyncedAt });
    insertSyncRun(fx, id, "succeeded", lastSyncedAt - 60_000);
    insertSyncRun(fx, id, "failed", NOW - 2 * HOUR_MS);
    await tick();
    expect(failingRows().map((row) => row.dedupeKey)).toEqual([`sync-failing:${id}:2026-11-07`]);
  });

  it.each(["skipped", "running", null] as const)(
    "stays quiet when the latest run is %s",
    async (latest) => {
      const id = insertAccount(fx, connectionId, {
        createdAt: NOW - 30 * DAY_MS,
        lastSyncedAt: NOW - 3 * DAY_MS,
      });
      if (latest !== null) {
        insertSyncRun(fx, id, "failed", NOW - 2 * HOUR_MS);
        insertSyncRun(fx, id, latest, NOW - HOUR_MS);
      }
      await tick();
      expect(failingRows()).toEqual([]);
    },
  );

  it("raises once per outage and again after a new success", async () => {
    const id = insertAccount(fx, connectionId, {
      createdAt: NOW - 30 * DAY_MS,
      lastSyncedAt: NOW - 3 * DAY_MS,
    });
    insertSyncRun(fx, id, "failed", NOW - HOUR_MS);
    await tick();
    await tick();
    expect(failingRows()).toHaveLength(1);

    insertSyncRun(fx, id, "succeeded", NOW + HOUR_MS);
    fx.repo.updateAccount(id, { lastSyncedAt: NOW + HOUR_MS });
    fx.clock.now += 3 * DAY_MS;
    insertSyncRun(fx, id, "failed", fx.clock.now - HOUR_MS);
    await tick();
    expect(failingRows().map((row) => row.dedupeKey)).toEqual([
      `sync-failing:${id}:2026-11-06`,
      `sync-failing:${id}:2026-11-09`,
    ]);
  });

  it("ignores accounts that are not active and connections that cannot sync", async () => {
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
      insertAccount(fx, connectionId, { ...old, status: "unavailable" }),
      insertAccount(fx, lapsed, old),
      insertAccount(fx, revoked, old),
      insertAccount(fx, removed, old),
    ];
    for (const id of ids) insertSyncRun(fx, id, "failed", NOW - HOUR_MS);
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
    insertSyncRun(fx, id, "failed", NOW - HOUR_MS);
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
