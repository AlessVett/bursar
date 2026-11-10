import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnableBankingApi } from "../eb/client";
import { EnableBankingError, parseEbErrorBody } from "../eb/errors";
import rateLimitError from "../eb/fixtures/error-rate-limit.json";
import type { JobRecord } from "../jobs/queue";
import {
  DELETE_SESSION_JOB,
  SYNC_ACCOUNT_JOB,
  syncDedupeKey,
  syncFollowUpDedupeKey,
} from "../jobs/types";
import { type JobHandler, JobWorker, PermanentJobError } from "../jobs/worker";
import {
  auditRows,
  BANK_NAME,
  createLifecycleFixture,
  DAY_MS,
  HOUR_MS,
  insertAccount,
  insertBalance,
  insertConnection,
  insertSyncRun,
  insertTransactions,
  jobRows,
  type LifecycleFixture,
  NOW,
  SESSION_ID,
  stubBankingApi,
} from "../test/lifecycle";
import {
  AlreadyRemovedError,
  ConnectionLifecycle,
  DELETE_SESSION_MAX_ATTEMPTS,
  DELETE_SESSION_RETRY_DELAY_MS,
  deleteSessionDedupeKey,
  deleteSessionJobHandler,
} from "./lifecycle";

const ENDED_CODES = [
  "CLOSED_SESSION",
  "EXPIRED_SESSION",
  "SESSION_DOES_NOT_EXIST",
  "REVOKED_SESSION",
] as const;

const aspspError = () =>
  parseEbErrorBody(500, { message: "ASPSP error", code: 500, error: "ASPSP_ERROR" });
const endedError = (code: string) =>
  parseEbErrorBody(401, { message: "Session is no longer valid", code: 401, error: code });

let fx: LifecycleFixture;

beforeEach(() => {
  fx = createLifecycleFixture();
});
afterEach(() => fx.dispose());

function lifecycle(api: EnableBankingApi | null): ConnectionLifecycle {
  return new ConnectionLifecycle({
    repo: fx.repo,
    api,
    queue: fx.queue,
    bus: fx.bus,
    audit: fx.audit,
    now: () => fx.clock.now,
  });
}

/** One connection, two accounts: 3 + 2 transactions, one balance and one sync run on the first. */
function seedBank() {
  const connectionId = insertConnection(fx, { validUntil: NOW + 90 * DAY_MS });
  const first = insertAccount(fx, connectionId, { nickname: "Conto spese" });
  const second = insertAccount(fx, connectionId, { product: "Conto deposito" });
  insertTransactions(fx, first, 3);
  insertTransactions(fx, second, 2);
  insertBalance(fx, first);
  insertSyncRun(fx, first, "succeeded", NOW - HOUR_MS);
  return { connectionId, first, second };
}

function closingBank() {
  const deleteSession = vi.fn(async (_sessionId: string) => {});
  return { api: stubBankingApi({ deleteSession }), deleteSession };
}

const deleteJob = (payload: unknown): JobRecord => ({
  id: 1,
  type: DELETE_SESSION_JOB,
  payload,
  attempts: 1,
  maxAttempts: DELETE_SESSION_MAX_ATTEMPTS,
});

describe("ConnectionLifecycle.removalPreview", () => {
  it("counts the accounts and transactions a disconnect affects", () => {
    const { connectionId } = seedBank();
    expect(lifecycle(null).removalPreview(connectionId)).toEqual({
      bankName: BANK_NAME,
      accounts: 2,
      transactions: 5,
    });
  });

  it("returns null for an unknown connection", () => {
    expect(lifecycle(null).removalPreview(999)).toBeNull();
  });
});

describe("ConnectionLifecycle.disconnect", () => {
  it("closes the bank session, removes the accounts and keeps their transactions", async () => {
    const { connectionId, first, second } = seedBank();
    const { api, deleteSession } = closingBank();

    expect(await lifecycle(api).disconnect(connectionId)).toEqual({ removedAccounts: 2 });

    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith(SESSION_ID);
    expect(fx.repo.getConnection(connectionId)?.removedAt).toBe(NOW);
    for (const id of [first, second]) {
      expect(fx.repo.getAccount(id)).toMatchObject({ status: "removed", removedAt: NOW });
    }
    expect(fx.repo.countTransactions(first).total).toBe(3);
    expect(fx.repo.countTransactions(second).total).toBe(2);
    expect(jobRows(fx, DELETE_SESSION_JOB)).toEqual([]);
    expect(auditRows(fx)).toEqual([
      {
        actor: "user",
        action: "connection.remove",
        target: `connection:${connectionId}`,
        details: { accounts: 2, remoteSession: "closed" },
      },
    ]);
    expect(fx.events).toContainEqual({
      type: "connection.updated",
      connectionId,
      status: "active",
    });
  });

  it("cancels queued syncs and leaves a running one alone", async () => {
    const { connectionId, first, second } = seedBank();
    for (const accountId of [first, second]) {
      fx.queue.enqueueUnique(SYNC_ACCOUNT_JOB, syncDedupeKey(accountId), {
        accountId,
        trigger: "background",
      });
    }
    expect(fx.queue.claimNext()?.payload).toEqual({ accountId: first, trigger: "background" });
    // A renewal queued a follow-up behind the running sync.
    fx.queue.enqueueUnique(SYNC_ACCOUNT_JOB, syncFollowUpDedupeKey(first), {
      accountId: first,
      trigger: "renewal",
    });

    await lifecycle(closingBank().api).disconnect(connectionId);

    expect(fx.queue.findActive(syncDedupeKey(first))).toMatchObject({ status: "running" });
    expect(fx.queue.findActive(syncDedupeKey(second))).toBeNull();
    expect(fx.queue.findActive(syncFollowUpDedupeKey(first))).toBeNull();
  });

  it("queues a retry when the bank cannot close the session", async () => {
    const { connectionId } = seedBank();
    const api = stubBankingApi({ deleteSession: () => Promise.reject(aspspError()) });

    expect(await lifecycle(api).disconnect(connectionId)).toEqual({ removedAccounts: 2 });

    const jobs = jobRows(fx, DELETE_SESSION_JOB);
    expect(jobs).toEqual([
      {
        payload: { providerSessionId: SESSION_ID },
        status: "queued",
        runAfter: NOW + DELETE_SESSION_RETRY_DELAY_MS,
        maxAttempts: DELETE_SESSION_MAX_ATTEMPTS,
        dedupeKey: deleteSessionDedupeKey(SESSION_ID),
      },
    ]);
    expect(jobs[0]?.dedupeKey).not.toContain(SESSION_ID);
    expect(auditRows(fx)[0]?.details).toEqual({ accounts: 2, remoteSession: "queued" });
    expect(fx.repo.getConnection(connectionId)?.removedAt).toBe(NOW);
  });

  it("queues a retry after a network failure", async () => {
    const { connectionId } = seedBank();
    const api = stubBankingApi({
      deleteSession: () => Promise.reject(new TypeError("fetch failed")),
    });
    await lifecycle(api).disconnect(connectionId);
    expect(jobRows(fx, DELETE_SESSION_JOB)).toHaveLength(1);
  });

  it.each(ENDED_CODES)("treats %s as an already closed session", async (code) => {
    const { connectionId } = seedBank();
    const api = stubBankingApi({ deleteSession: () => Promise.reject(endedError(code)) });
    await lifecycle(api).disconnect(connectionId);
    expect(jobRows(fx, DELETE_SESSION_JOB)).toEqual([]);
    expect(auditRows(fx)[0]?.details).toEqual({ accounts: 2, remoteSession: "already_ended" });
  });

  it("removes locally when banking is not configured", async () => {
    const { connectionId, first } = seedBank();
    expect(await lifecycle(null).disconnect(connectionId)).toEqual({ removedAccounts: 2 });
    expect(fx.repo.getAccount(first)?.status).toBe("removed");
    expect(jobRows(fx, DELETE_SESSION_JOB)).toEqual([]);
    expect(auditRows(fx)[0]?.details).toEqual({ accounts: 2, remoteSession: "local_only" });
  });

  it("refuses a second disconnect without calling the bank again", async () => {
    const { connectionId } = seedBank();
    const { api, deleteSession } = closingBank();
    await lifecycle(api).disconnect(connectionId);
    await expect(lifecycle(api).disconnect(connectionId)).rejects.toBeInstanceOf(
      AlreadyRemovedError,
    );
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(auditRows(fx)).toHaveLength(1);
  });

  it("returns null for an unknown connection", async () => {
    const { api, deleteSession } = closingBank();
    expect(await lifecycle(api).disconnect(999)).toBeNull();
    expect(deleteSession).not.toHaveBeenCalled();
  });
});

describe("ConnectionLifecycle.purgeAccount", () => {
  it("refuses an account that is not removed", () => {
    const { first } = seedBank();
    expect(lifecycle(null).purgeAccount(first)).toBe("not_removed");
    expect(fx.repo.countTransactions(first).total).toBe(3);
    expect(auditRows(fx)).toEqual([]);
  });

  it("purges removed accounts and deletes the connection after the last one", async () => {
    const { connectionId, first, second } = seedBank();
    await lifecycle(null).disconnect(connectionId);

    expect(lifecycle(null).purgeAccount(first)).toEqual({ transactions: 3, balances: 1 });
    expect(fx.repo.getAccount(first)).toBeNull();
    expect(fx.repo.getConnection(connectionId)).not.toBeNull();

    expect(lifecycle(null).purgeAccount(second)).toEqual({ transactions: 2, balances: 0 });
    expect(fx.repo.getConnection(connectionId)).toBeNull();

    expect(auditRows(fx).filter((row) => row.action === "account.purge")).toEqual([
      {
        actor: "user",
        action: "account.purge",
        target: `account:${first}`,
        details: { transactions: 3, balances: 1, syncRuns: 1, connectionDeleted: false },
      },
      {
        actor: "user",
        action: "account.purge",
        target: `account:${second}`,
        details: { transactions: 2, balances: 0, syncRuns: 0, connectionDeleted: true },
      },
    ]);
  });

  it("cancels a queued sync of the purged account", async () => {
    const { connectionId, first } = seedBank();
    await lifecycle(null).disconnect(connectionId);
    fx.queue.enqueueUnique(SYNC_ACCOUNT_JOB, syncDedupeKey(first), {
      accountId: first,
      trigger: "background",
    });
    fx.queue.enqueueUnique(SYNC_ACCOUNT_JOB, syncFollowUpDedupeKey(first), {
      accountId: first,
      trigger: "renewal",
    });
    lifecycle(null).purgeAccount(first);
    expect(fx.queue.findActive(syncDedupeKey(first))).toBeNull();
    expect(fx.queue.findActive(syncFollowUpDedupeKey(first))).toBeNull();
  });

  it("returns null for an unknown account", () => {
    expect(lifecycle(null).purgeAccount(999)).toBeNull();
  });
});

describe("deleteSessionJobHandler", () => {
  it("closes the session", async () => {
    const { api, deleteSession } = closingBank();
    await deleteSessionJobHandler({ api })(deleteJob({ providerSessionId: SESSION_ID }));
    expect(deleteSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it.each(ENDED_CODES)("is done when the bank answers %s", async (code) => {
    const api = stubBankingApi({ deleteSession: () => Promise.reject(endedError(code)) });
    await expect(
      deleteSessionJobHandler({ api })(deleteJob({ providerSessionId: SESSION_ID })),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["ASPSP_ERROR", aspspError],
    ["the bank rate limit", () => parseEbErrorBody(429, rateLimitError)],
    ["no HTTP answer", () => parseEbErrorBody(0, null)],
  ] as const)("lets the queue retry after %s", async (_label, makeError) => {
    const api = stubBankingApi({ deleteSession: () => Promise.reject(makeError()) });
    const error = await deleteSessionJobHandler({ api })(
      deleteJob({ providerSessionId: SESSION_ID }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EnableBankingError);
    expect(error).not.toBeInstanceOf(PermanentJobError);
  });

  it("fails permanently on other Enable Banking errors", async () => {
    const api = stubBankingApi({
      deleteSession: () =>
        Promise.reject(
          parseEbErrorBody(400, {
            message: "Wrong request parameters",
            code: 400,
            error: "WRONG_REQUEST_PARAMETERS",
          }),
        ),
    });
    await expect(
      deleteSessionJobHandler({ api })(deleteJob({ providerSessionId: SESSION_ID })),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("fails permanently when banking is not configured", async () => {
    await expect(
      deleteSessionJobHandler({ api: null })(deleteJob({ providerSessionId: SESSION_ID })),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("fails permanently on an invalid payload", async () => {
    const { api, deleteSession } = closingBank();
    await expect(
      deleteSessionJobHandler({ api })(deleteJob({ providerSessionId: "" })),
    ).rejects.toBeInstanceOf(PermanentJobError);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("fails permanently on an unexpected error without echoing it", async () => {
    const api = stubBankingApi({
      deleteSession: () => Promise.reject(new TypeError(`boom ${SESSION_ID}`)),
    });
    const error = await deleteSessionJobHandler({ api })(
      deleteJob({ providerSessionId: SESSION_ID }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as Error).message).not.toContain(SESSION_ID);
  });

  it("runs the queued retry through the worker", async () => {
    const { connectionId } = seedBank();
    await lifecycle(
      stubBankingApi({ deleteSession: () => Promise.reject(aspspError()) }),
    ).disconnect(connectionId);
    const { api, deleteSession } = closingBank();
    const worker = new JobWorker(
      fx.queue,
      new Map<string, JobHandler>([[DELETE_SESSION_JOB, deleteSessionJobHandler({ api })]]),
      pino({ level: "silent" }),
    );

    expect(await worker.runOnce()).toBe(false);
    fx.clock.now += DELETE_SESSION_RETRY_DELAY_MS;
    expect(await worker.runOnce()).toBe(true);

    expect(deleteSession).toHaveBeenCalledWith(SESSION_ID);
    expect(jobRows(fx, DELETE_SESSION_JOB)[0]?.status).toBe("succeeded");
  });
});

describe("FinanceRepository.deleteConnection", () => {
  it("deletes the row and its pending auth requests", () => {
    const connectionId = insertConnection(fx, { validUntil: NOW + DAY_MS });
    fx.t.sqlite
      .prepare(
        `INSERT INTO bank_auth_requests (state_hash, purpose, connection_id, aspsp_name, aspsp_country,
           valid_until, created_at, expires_at)
         VALUES (?, 'renew', ?, ?, 'IT', ?, ?, ?)`,
      )
      .run("a".repeat(64), connectionId, BANK_NAME, NOW + DAY_MS, NOW, NOW + 30 * 60_000);

    expect(fx.repo.deleteConnection(connectionId)).toBe(true);
    expect(fx.repo.getConnection(connectionId)).toBeNull();
    expect(fx.t.sqlite.prepare("SELECT count(*) AS n FROM bank_auth_requests").get()).toEqual({
      n: 0,
    });
    expect(fx.repo.deleteConnection(connectionId)).toBe(false);
  });

  it("refuses while accounts still reference the connection", () => {
    const { connectionId } = seedBank();
    expect(() => fx.repo.deleteConnection(connectionId)).toThrow();
    expect(fx.repo.getConnection(connectionId)).not.toBeNull();
  });
});
