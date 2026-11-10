import type { SkipReason, SyncTrigger } from "@bursar/shared";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PsuHeaders } from "../eb/client";
import type { EbTransaction } from "../eb/schemas";
import { SYNC_ACCOUNT_JOB } from "../jobs/types";
import { type JobHandler, JobWorker, PermanentJobError } from "../jobs/worker";
import {
  type AccountSeed,
  type ConnectionSeed,
  createSyncHarness,
  DAY_MS,
  ebError,
  eventsOf,
  GROCERIES,
  insertAccount,
  insertConnection,
  PENDING_COFFEE,
  SALARY,
  SYNC_TEST_NOW,
  type SyncHarness,
} from "../test/sync-fixture";
import {
  enqueueAccountSync,
  MAX_TRANSACTION_PAGES,
  RATE_LIMIT_PAUSE_MS,
  runAccountSync,
  syncAccountHandler,
  unconfiguredSyncHandler,
} from "./sync";

const HOUR_MS = 3_600_000;
const FIRST_ATTEMPT = { number: 1, max: 3 };
const PUBLIC_PSU: PsuHeaders = {
  ipAddress: "203.0.113.24",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) ExampleBrowser/1.0",
  acceptLanguage: "it-IT,it;q=0.9",
};
const PRIVATE_PSU: PsuHeaders = { ...PUBLIC_PSU, ipAddress: "10.0.0.4" };

let h: SyncHarness;
let connectionId: number;
let accountId: number;

beforeEach(() => {
  h = createSyncHarness();
  connectionId = insertConnection(h.t.sqlite, { now: h.clock.now });
  accountId = insertAccount(h.t.sqlite, { connectionId, now: h.clock.now });
});
afterEach(() => h.dispose());

function sync(trigger: SyncTrigger, psu?: PsuHeaders, id: number = accountId) {
  return runAccountSync(
    h.deps,
    psu ? { accountId: id, trigger, psu } : { accountId: id, trigger },
    FIRST_ATTEMPT,
  );
}

function lastRun(id: number = accountId) {
  return h.repo.listSyncRuns(id, 100).reduce((latest, run) => (run.id > latest.id ? run : latest));
}

function createWorker(handler: JobHandler): JobWorker {
  return new JobWorker(h.queue, new Map([[SYNC_ACCOUNT_JOB, handler]]), pino({ level: "silent" }));
}

describe("runAccountSync: fetching and storing", () => {
  it("runs the first sync with strategy longest, stores balances and inserts every transaction", async () => {
    const outcome = await sync("initial");
    expect(outcome).toEqual({
      status: "succeeded",
      fetched: 3,
      inserted: 3,
      updated: 0,
      removed: 0,
      errorCode: null,
      skipReason: null,
      retryAt: null,
    });
    expect(h.bank.transactionCalls.map((call) => call.query)).toEqual([
      { strategy: "longest" },
      { strategy: "longest", continuationKey: "page-2" },
    ]);
    expect(h.bank.balanceCalls).toEqual([{ accountUid: expect.any(String), psu: undefined }]);
    const balances = h.repo.latestBalances(accountId);
    expect(balances).toHaveLength(2);
    expect(balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          balanceType: "CLBD",
          amountMinor: 152_040,
          currency: "EUR",
          referenceDate: "2026-11-08",
        }),
        expect.objectContaining({
          balanceType: "ITAV",
          amountMinor: 149_015,
          currency: "EUR",
          referenceDate: "2026-11-09",
        }),
      ]),
    );
    expect(h.repo.countTransactions(accountId)).toEqual({ total: 3, pending: 1 });
    expect(h.repo.getAccount(accountId)).toMatchObject({
      lastSyncedAt: SYNC_TEST_NOW,
      lastSyncErrorCode: null,
      bgFetchCount: 1,
    });
    expect(lastRun()).toMatchObject({
      trigger: "initial",
      status: "succeeded",
      withPsuHeaders: false,
      fetched: 3,
      inserted: 3,
      finishedAt: SYNC_TEST_NOW,
    });
  });

  it("publishes started, one progress event per page and finished", async () => {
    await sync("initial");
    expect(h.events.map((event) => event.type)).toEqual([
      "sync.started",
      "sync.progress",
      "sync.progress",
      "sync.finished",
    ]);
    expect(eventsOf(h.events, "sync.started")).toEqual([
      { type: "sync.started", accountId, connectionId, trigger: "initial" },
    ]);
    expect(eventsOf(h.events, "sync.progress").map((event) => event.fetched)).toEqual([2, 3]);
    expect(eventsOf(h.events, "sync.finished")).toEqual([
      {
        type: "sync.finished",
        accountId,
        connectionId,
        trigger: "initial",
        status: "succeeded",
        inserted: 3,
        updated: 0,
        removed: 0,
        errorCode: null,
        skipReason: null,
        retryAt: null,
      },
    ]);
  });

  it("uses strategy longest for any trigger while the account has no booked transaction", async () => {
    await sync("background");
    expect(h.bank.transactionCalls[0]?.query).toEqual({ strategy: "longest" });
  });

  it("fetches incrementally from the last booked date minus seven days", async () => {
    await sync("initial");
    const outcome = await sync("background");
    expect(h.bank.transactionCalls.slice(2).map((call) => call.query)).toEqual([
      { strategy: "default", dateFrom: "2026-10-31" },
      { strategy: "default", dateFrom: "2026-10-31", continuationKey: "page-2" },
    ]);
    expect(outcome).toMatchObject({ status: "succeeded", fetched: 3, inserted: 0 });
    expect(h.repo.countTransactions(accountId)).toEqual({ total: 3, pending: 1 });
  });

  it("never asks for a start date in the future", async () => {
    h.bank.pages = [
      {
        transactions: [
          {
            ...GROCERIES,
            entry_reference: "ENTRY-0099",
            booking_date: "2026-11-20",
            value_date: "2026-11-20",
          },
        ],
        continuation_key: null,
      },
    ];
    await sync("initial");
    await sync("background");
    // The anchor is clamped to today, then the seven-day look-back applies.
    expect(h.bank.transactionCalls[1]?.query).toEqual({
      strategy: "default",
      dateFrom: "2026-11-02",
    });
  });

  it("keeps the seven-day look-back when a booked entry is dated weeks ahead", async () => {
    h.settings.update({ backgroundSyncCap: 4 });
    const settlement: EbTransaction = {
      ...GROCERIES,
      entry_reference: "ENTRY-0098",
      transaction_id: "tx-0098",
      booking_date: "2026-11-29",
      value_date: "2026-11-29",
    };
    h.bank.pages = [{ transactions: [settlement, SALARY], continuation_key: null }];
    await sync("initial");
    // Listed late by the bank: booked last Friday, it only shows up today.
    const late: EbTransaction = {
      ...GROCERIES,
      entry_reference: "ENTRY-0097",
      transaction_id: "tx-0097",
      booking_date: "2026-11-06",
      value_date: "2026-11-06",
    };
    // Like a bank that honours date_from: only entries on or after the requested day.
    h.bank.transactionsImpl = (query) => ({
      transactions: [settlement, late, SALARY].filter(
        (tx) => query.dateFrom === undefined || (tx.booking_date ?? "") >= query.dateFrom,
      ),
      continuation_key: null,
    });
    const outcome = await sync("background");
    // Anchored at today rather than at the future date, so the window still reaches back a week
    // and never starts after yesterday (Enable Banking reads date_from as a UTC date).
    expect(h.bank.transactionCalls[1]?.query).toEqual({
      strategy: "default",
      dateFrom: "2026-11-02",
    });
    expect(outcome).toMatchObject({ status: "succeeded", inserted: 1, removed: 0 });
    expect(h.repo.countTransactions(accountId)).toEqual({ total: 3, pending: 0 });
  });

  it("matches a stored entry the bank returns from before the window when it ignores date_from", async () => {
    const old: EbTransaction = {
      ...GROCERIES,
      entry_reference: "ENTRY-OLD",
      transaction_id: "tx-old",
      booking_date: "2026-09-20",
      value_date: "2026-09-20",
    };
    // Like the Mock ASPSP: every request returns the whole list, whatever date_from says.
    h.bank.pages = [
      { transactions: [PENDING_COFFEE, GROCERIES, SALARY, old], continuation_key: null },
    ];
    expect(await sync("initial")).toMatchObject({ status: "succeeded", inserted: 4 });
    const outcome = await sync("background");
    expect(h.bank.transactionCalls[1]?.query).toEqual({
      strategy: "default",
      dateFrom: "2026-10-31",
    });
    expect(outcome).toMatchObject({ status: "succeeded", fetched: 4, inserted: 0 });
    expect(h.repo.countTransactions(accountId)).toEqual({ total: 4, pending: 1 });
  });

  it("reaches back to an old pending entry so it is removed after two missed syncs", async () => {
    h.settings.update({ backgroundSyncCap: 4 });
    const hold: EbTransaction = {
      ...PENDING_COFFEE,
      transaction_amount: { currency: "EUR", amount: "150.00" },
      creditor: { name: "Hotel Esempio" },
      transaction_date: "2026-10-20",
    };
    h.bank.pages = [{ transactions: [hold, GROCERIES, SALARY], continuation_key: null }];
    await sync("initial");
    h.bank.pages = [{ transactions: [GROCERIES, SALARY], continuation_key: null }];
    expect(await sync("background")).toMatchObject({ status: "succeeded", removed: 0 });
    // lastBooked − 7 would be 2026-10-31; the stored hold of 2026-10-20 widens the window.
    expect(h.bank.transactionCalls[1]?.query).toEqual({
      strategy: "default",
      dateFrom: "2026-10-20",
    });
    expect(await sync("background")).toMatchObject({ status: "succeeded", removed: 1 });
    expect(h.repo.countTransactions(accountId)).toEqual({ total: 2, pending: 0 });
  });

  it("skips unreadable provider items, stores the rest and says how many it skipped", async () => {
    const malformed: EbTransaction = {
      ...GROCERIES,
      entry_reference: "ENTRY-0003",
      transaction_amount: { currency: "EUR", amount: "42.805" },
    };
    // `skipped: 1` is the client's count of an item with an unknown credit_debit_indicator.
    h.bank.pages = [{ transactions: [malformed, SALARY], continuation_key: null, skipped: 1 }];
    expect(await sync("initial")).toMatchObject({ status: "succeeded", fetched: 2, inserted: 1 });
    expect(h.repo.countTransactions(accountId)).toEqual({ total: 1, pending: 0 });
    expect(lastRun()).toMatchObject({
      status: "succeeded",
      errorMessage: "2 provider entries skipped",
    });
    expect(h.repo.getAccount(accountId)?.lastSyncErrorCode).toBeNull();
  });

  it("writes nothing for an account removed while the bank was answering", async () => {
    h.bank.transactionsImpl = () => {
      h.repo.updateAccount(accountId, { status: "removed" });
      return { transactions: [SALARY], continuation_key: null };
    };
    expect(await sync("initial")).toMatchObject({
      status: "skipped",
      skipReason: "account_inactive",
    });
    expect(h.repo.getAccount(accountId)?.status).toBe("removed");
    expect(h.repo.countTransactions(accountId)).toEqual({ total: 0, pending: 0 });
    expect(h.repo.latestBalances(accountId)).toEqual([]);

    // A late account-level error does not turn the removed account back into an unavailable one.
    h.repo.updateAccount(accountId, { status: "active" });
    h.bank.transactionsImpl = () => {
      h.repo.updateAccount(accountId, { status: "removed" });
      throw ebError(404, "ACCOUNT_DOES_NOT_EXIST", "Account does not exist");
    };
    expect(await sync("background")).toMatchObject({
      status: "skipped",
      skipReason: "account_inactive",
    });
    expect(h.repo.getAccount(accountId)?.status).toBe("removed");
  });

  it("falls back to strategy longest once when the bank rejects the period", async () => {
    await sync("initial");
    h.bank.transactionErrors.push(
      ebError(422, "WRONG_TRANSACTIONS_PERIOD", "Wrong transactions period requested"),
    );
    const outcome = await sync("background");
    expect(h.bank.transactionCalls.slice(2).map((call) => call.query)).toEqual([
      { strategy: "default", dateFrom: "2026-10-31" },
      { strategy: "longest" },
      { strategy: "longest", continuationKey: "page-2" },
    ]);
    expect(outcome).toMatchObject({ status: "succeeded", inserted: 0 });
  });

  it("stops with PAGINATION_LOOP when a continuation key repeats", async () => {
    h.bank.transactionsImpl = () => ({ transactions: [], continuation_key: "same-key" });
    const error = await sync("initial").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as Error).message).toBe("PAGINATION_LOOP");
    expect(h.bank.transactionCalls).toHaveLength(2);
    expect(lastRun()).toMatchObject({ status: "failed", errorCode: "PAGINATION_LOOP" });
    expect(h.repo.getAccount(accountId)?.lastSyncErrorCode).toBe("PAGINATION_LOOP");
    expect(eventsOf(h.events, "sync.finished")[0]).toMatchObject({
      status: "failed",
      errorCode: "PAGINATION_LOOP",
    });
  });

  it("stops after MAX_TRANSACTION_PAGES pages", async () => {
    let page = 0;
    h.bank.transactionsImpl = () => {
      page += 1;
      return { transactions: [], continuation_key: `key-${page}` };
    };
    await expect(sync("initial")).rejects.toThrow("PAGINATION_LOOP");
    expect(h.bank.transactionCalls).toHaveLength(MAX_TRANSACTION_PAGES);
    expect(h.repo.countTransactions(accountId)).toEqual({ total: 0, pending: 0 });
  });
});

interface SkipCase {
  label: string;
  connection: Omit<Partial<ConnectionSeed>, "now">;
  account: Omit<Partial<AccountSeed>, "connectionId" | "now">;
  reason: SkipReason;
}

const SKIP_CASES: SkipCase[] = [
  {
    label: "a disabled account",
    connection: {},
    account: { status: "disabled" },
    reason: "account_inactive",
  },
  {
    label: "an account without a provider id",
    connection: {},
    account: { providerAccountUid: null },
    reason: "no_provider_uid",
  },
  {
    label: "a revoked connection",
    connection: { status: "revoked" },
    account: {},
    reason: "connection_inactive",
  },
  {
    label: "a consent past its end date",
    connection: { validUntil: SYNC_TEST_NOW - HOUR_MS },
    account: {},
    reason: "connection_inactive",
  },
  {
    label: "a removed connection",
    connection: { removedAt: SYNC_TEST_NOW - DAY_MS },
    account: {},
    reason: "connection_inactive",
  },
];

describe("runAccountSync: skips", () => {
  it.each(SKIP_CASES)("skips $label without calling the bank", async (skipCase) => {
    const otherConnection = insertConnection(h.t.sqlite, {
      now: h.clock.now,
      ...skipCase.connection,
    });
    const otherAccount = insertAccount(h.t.sqlite, {
      connectionId: otherConnection,
      now: h.clock.now,
      ...skipCase.account,
    });
    const outcome = await sync("background", undefined, otherAccount);
    expect(outcome).toMatchObject({
      status: "skipped",
      skipReason: skipCase.reason,
      retryAt: null,
    });
    expect(h.bank.balanceCalls).toHaveLength(0);
    expect(lastRun(otherAccount)).toMatchObject({
      status: "skipped",
      skipReason: skipCase.reason,
    });
    expect(eventsOf(h.events, "sync.started")).toHaveLength(0);
    expect(eventsOf(h.events, "sync.finished")).toEqual([
      expect.objectContaining({
        accountId: otherAccount,
        status: "skipped",
        skipReason: skipCase.reason,
      }),
    ]);
    expect(h.repo.getAccount(otherAccount)?.bgFetchCount).toBe(0);
  });

  it("skips a paused account until the pause ends", async () => {
    const pausedUntil = SYNC_TEST_NOW + 2 * HOUR_MS;
    const paused = insertAccount(h.t.sqlite, {
      connectionId,
      now: h.clock.now,
      rateLimitedUntil: pausedUntil,
    });
    expect(await sync("background", undefined, paused)).toMatchObject({
      status: "skipped",
      skipReason: "rate_limited",
      retryAt: pausedUntil,
    });
    expect(h.bank.balanceCalls).toHaveLength(0);
    h.clock.now = pausedUntil;
    expect((await sync("background", undefined, paused)).status).toBe("succeeded");
  });
});

describe("runAccountSync: background cap", () => {
  it("caps background fetches per local day and resets at local midnight", async () => {
    h.clock.now = Date.UTC(2026, 10, 9, 22, 30); // 23:30 on 9 November in Rome
    expect((await sync("background")).status).toBe("succeeded");
    expect((await sync("background")).status).toBe("succeeded");
    expect(await sync("background")).toMatchObject({ status: "skipped", skipReason: "daily_cap" });
    expect(h.bank.balanceCalls).toHaveLength(2);
    expect(lastRun()).toMatchObject({ status: "skipped", skipReason: "daily_cap" });
    h.clock.now += HOUR_MS; // 00:30 on 10 November in Rome, still 9 November in UTC
    expect((await sync("background")).status).toBe("succeeded");
    expect(h.repo.getAccount(accountId)).toMatchObject({
      bgFetchDay: "2026-11-10",
      bgFetchCount: 1,
    });
  });

  it("counts initial and renewal syncs against the cap", async () => {
    h.settings.update({ backgroundSyncCap: 1 });
    expect((await sync("initial")).status).toBe("succeeded");
    expect(await sync("renewal")).toMatchObject({ status: "skipped", skipReason: "daily_cap" });
  });

  it("charges an initial sync once, so its retries run even when the cap is spent", async () => {
    h.settings.update({ backgroundSyncCap: 1 });
    h.bank.balanceErrors.push(
      ebError(500, "ASPSP_ERROR", "Bank error"),
      ebError(500, "ASPSP_ERROR", "Bank error"),
    );
    const payload = { accountId, trigger: "initial" as const };
    await expect(runAccountSync(h.deps, payload, { number: 1, max: 3 })).rejects.toThrow();
    await expect(runAccountSync(h.deps, payload, { number: 2, max: 3 })).rejects.toThrow();
    expect(await runAccountSync(h.deps, payload, { number: 3, max: 3 })).toMatchObject({
      status: "succeeded",
    });
    expect(h.repo.getAccount(accountId)?.bgFetchCount).toBe(1);
    expect(await sync("background")).toMatchObject({ status: "skipped", skipReason: "daily_cap" });
  });
});

describe("runAccountSync: manual sync and PSU headers", () => {
  it("sends PSU headers for a manual sync from a public address and leaves the cap untouched", async () => {
    h.settings.update({ backgroundSyncCap: 1 });
    await sync("background");
    const outcome = await sync("manual", PUBLIC_PSU);
    expect(outcome.status).toBe("succeeded");
    expect(h.bank.balanceCalls[1]?.psu).toEqual(PUBLIC_PSU);
    expect(h.bank.transactionCalls.at(-1)?.psu).toEqual(PUBLIC_PSU);
    expect(lastRun()).toMatchObject({
      trigger: "manual",
      status: "succeeded",
      withPsuHeaders: true,
    });
    expect(h.repo.getAccount(accountId)?.bgFetchCount).toBe(1);
  });

  it("treats a manual sync from a private address as a background fetch", async () => {
    h.settings.update({ backgroundSyncCap: 1 });
    expect((await sync("manual", PRIVATE_PSU)).status).toBe("succeeded");
    expect(h.bank.balanceCalls[0]?.psu).toBeUndefined();
    expect(lastRun()).toMatchObject({ trigger: "manual", withPsuHeaders: false });
    expect(await sync("manual", PRIVATE_PSU)).toMatchObject({
      status: "skipped",
      skipReason: "daily_cap",
    });
  });

  it("never forwards PSU headers for a trigger other than manual", async () => {
    await sync("background", PUBLIC_PSU);
    expect(h.bank.balanceCalls[0]?.psu).toBeUndefined();
    expect(h.bank.transactionCalls.every((call) => call.psu === undefined)).toBe(true);
    expect(h.repo.getAccount(accountId)?.bgFetchCount).toBe(1);
  });

  it("retries once without PSU headers when the bank refuses them", async () => {
    h.bank.balanceErrors.push(
      ebError(422, "PSU_HEADER_NOT_PROVIDED", "Required PSU header is not provided"),
    );
    const outcome = await sync("manual", PUBLIC_PSU);
    expect(outcome.status).toBe("succeeded");
    expect(h.bank.balanceCalls.map((call) => call.psu)).toEqual([PUBLIC_PSU, undefined]);
    expect(h.bank.transactionCalls.every((call) => call.psu === undefined)).toBe(true);
    expect(lastRun()).toMatchObject({ status: "succeeded", withPsuHeaders: false });
    expect(h.repo.getAccount(accountId)?.bgFetchCount).toBe(1);
  });

  it("skips with daily_cap when the fallback has no background fetch left", async () => {
    h.settings.update({ backgroundSyncCap: 1 });
    await sync("background");
    h.bank.balanceErrors.push(ebError(422, "PSU_HEADER_INVALID", "Invalid PSU header"));
    expect(await sync("manual", PUBLIC_PSU)).toMatchObject({
      status: "skipped",
      skipReason: "daily_cap",
    });
    expect(h.bank.balanceCalls).toHaveLength(2);
    expect(lastRun()).toMatchObject({
      status: "skipped",
      skipReason: "daily_cap",
      withPsuHeaders: false,
    });
  });
});

describe("runAccountSync: bank errors", () => {
  it("pauses the account for six hours on a bank rate limit", async () => {
    h.bank.balanceErrors.push(ebError(429, "ASPSP_RATE_LIMIT_EXCEEDED", "Rate limit exceeded"));
    const retryAt = SYNC_TEST_NOW + RATE_LIMIT_PAUSE_MS;
    expect(await sync("background")).toEqual({
      status: "skipped",
      fetched: 0,
      inserted: 0,
      updated: 0,
      removed: 0,
      errorCode: "ASPSP_RATE_LIMIT_EXCEEDED",
      skipReason: "rate_limited",
      retryAt,
    });
    expect(h.repo.getAccount(accountId)).toMatchObject({
      rateLimitedUntil: retryAt,
      lastSyncErrorCode: "ASPSP_RATE_LIMIT_EXCEEDED",
      lastSyncErrorAt: SYNC_TEST_NOW,
    });
    h.clock.now = SYNC_TEST_NOW + HOUR_MS;
    expect(await sync("background")).toMatchObject({
      status: "skipped",
      skipReason: "rate_limited",
      retryAt,
    });
    expect(h.bank.balanceCalls).toHaveLength(1);
    h.clock.now = retryAt;
    expect((await sync("background")).status).toBe("succeeded");
  });

  it("marks the connection expired on EXPIRED_SESSION, notifies and publishes the change", async () => {
    h.bank.balanceErrors.push(ebError(401, "EXPIRED_SESSION", "Session expired"));
    expect(await sync("background")).toMatchObject({
      status: "failed",
      errorCode: "EXPIRED_SESSION",
      retryAt: null,
    });
    expect(h.repo.getConnection(connectionId)).toMatchObject({
      status: "expired",
      lastErrorCode: "EXPIRED_SESSION",
    });
    const items = h.notifications.list(10).items;
    expect(items.map((item) => item.event)).toEqual(["consent_expired"]);
    expect(items[0]?.params).toEqual({ bankName: "Banca Esempio" });
    expect(eventsOf(h.events, "connection.updated")).toEqual([
      { type: "connection.updated", connectionId, status: "expired" },
    ]);
    expect(h.repo.getAccount(accountId)).toMatchObject({
      status: "active",
      lastSyncErrorCode: "EXPIRED_SESSION",
    });
    expect(await sync("background")).toMatchObject({
      status: "skipped",
      skipReason: "connection_inactive",
    });
  });

  it.each([
    { code: "REVOKED_SESSION", status: "revoked" },
    { code: "CLOSED_SESSION", status: "error" },
  ])("marks the connection $status on $code", async ({ code, status }) => {
    h.bank.balanceErrors.push(ebError(401, code, "Session ended"));
    expect(await sync("background")).toMatchObject({ status: "failed", errorCode: code });
    expect(h.repo.getConnection(connectionId)?.status).toBe(status);
    expect(h.notifications.list(10).items.map((item) => item.event)).toEqual(["connection_error"]);
  });

  it("marks the account unavailable when the bank no longer exposes it", async () => {
    h.bank.balanceErrors.push(ebError(404, "ACCOUNT_DOES_NOT_EXIST", "Account does not exist"));
    expect(await sync("background")).toMatchObject({
      status: "failed",
      errorCode: "ACCOUNT_DOES_NOT_EXIST",
    });
    expect(h.repo.getAccount(accountId)?.status).toBe("unavailable");
    expect(h.repo.getConnection(connectionId)?.status).toBe("active");
  });

  it("throws PermanentJobError for a fatal bank error", async () => {
    h.bank.balanceErrors.push(
      ebError(400, "WRONG_REQUEST_PARAMETERS", "Wrong request parameters provided"),
    );
    const error = await sync("background").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as Error).message).toBe("WRONG_REQUEST_PARAMETERS");
    expect(lastRun()).toMatchObject({ status: "failed", errorCode: "WRONG_REQUEST_PARAMETERS" });
  });
});

describe("syncAccountHandler", () => {
  it("retries a retryable bank error with backoff and fails after the last attempt", async () => {
    h.settings.update({ backgroundSyncCap: 4 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.bank.balanceErrors.push(ebError(500, "ASPSP_ERROR", "Bank error"));
    }
    const { id } = enqueueAccountSync(h.queue, accountId, "background");
    const worker = createWorker(syncAccountHandler(h.deps));

    await worker.runOnce();
    expect(h.queue.get(id)).toMatchObject({
      status: "queued",
      attempts: 1,
      runAfter: SYNC_TEST_NOW + 30_000,
    });
    h.clock.now += 30_000;
    await worker.runOnce();
    expect(h.queue.get(id)).toMatchObject({ status: "queued", attempts: 2 });
    h.clock.now += 120_000;
    await worker.runOnce();
    expect(h.queue.get(id)).toMatchObject({ status: "failed", attempts: 3 });

    expect(eventsOf(h.events, "sync.finished").map((event) => event.retryAt)).toEqual([
      SYNC_TEST_NOW + 30_000,
      SYNC_TEST_NOW + 30_000 + 120_000,
      null,
    ]);
    expect(h.repo.listSyncRuns(accountId, 10).map((run) => [run.status, run.errorCode])).toEqual([
      ["failed", "ASPSP_ERROR"],
      ["failed", "ASPSP_ERROR"],
      ["failed", "ASPSP_ERROR"],
    ]);
  });

  it("fails the job permanently for a fatal bank error", async () => {
    h.bank.balanceErrors.push(
      ebError(400, "WRONG_REQUEST_PARAMETERS", "Wrong request parameters provided"),
    );
    const { id } = enqueueAccountSync(h.queue, accountId, "background");
    await createWorker(syncAccountHandler(h.deps)).runOnce();
    const state = h.queue.get(id);
    expect(state).toMatchObject({ status: "failed", attempts: 1 });
    expect(state?.lastError).toContain("WRONG_REQUEST_PARAMETERS");
  });

  it("fails a job with an invalid payload permanently without calling the bank", async () => {
    const id = h.queue.enqueue(SYNC_ACCOUNT_JOB, { accountId: "one", trigger: "manual" });
    await createWorker(syncAccountHandler(h.deps)).runOnce();
    expect(h.queue.get(id)).toMatchObject({ status: "failed", attempts: 1 });
    expect(h.bank.balanceCalls).toHaveLength(0);
  });

  it("completes the job when the connection needs a new consent", async () => {
    h.bank.balanceErrors.push(ebError(401, "EXPIRED_SESSION", "Session expired"));
    const { id } = enqueueAccountSync(h.queue, accountId, "background");
    await createWorker(syncAccountHandler(h.deps)).runOnce();
    expect(h.queue.get(id)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("fails every job permanently when Enable Banking is not configured", async () => {
    const { id } = enqueueAccountSync(h.queue, accountId, "manual");
    await createWorker(unconfiguredSyncHandler()).runOnce();
    const state = h.queue.get(id);
    expect(state).toMatchObject({ status: "failed", attempts: 1 });
    expect(state?.lastError).toContain("banking_not_configured");
  });
});

describe("enqueueAccountSync", () => {
  it("dedupes by account and stores PSU headers only when given", () => {
    const first = enqueueAccountSync(h.queue, accountId, "manual", PUBLIC_PSU);
    expect(first.created).toBe(true);
    expect(enqueueAccountSync(h.queue, accountId, "background")).toEqual({
      id: first.id,
      created: false,
    });
    const other = insertAccount(h.t.sqlite, { connectionId, now: h.clock.now });
    enqueueAccountSync(h.queue, other, "background");
    expect([h.queue.claimNext()?.payload, h.queue.claimNext()?.payload]).toEqual([
      { accountId, trigger: "manual", psu: PUBLIC_PSU },
      { accountId: other, trigger: "background" },
    ]);
  });
});
