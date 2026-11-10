import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db";
import {
  FinanceRepository,
  type NewAccount,
  type NewConnection,
  type NewTransaction,
} from "./repository";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function connectionInput(overrides: Partial<NewConnection> = {}): NewConnection {
  return {
    aspspName: "Banca Esempio",
    aspspCountry: "IT",
    providerSessionId: "00000000-0000-4000-8000-000000000001",
    validUntil: NOW + 90 * DAY,
    ...overrides,
  };
}

function accountInput(connectionId: number, overrides: Partial<NewAccount> = {}): NewAccount {
  return {
    connectionId,
    identificationHash: "hash-1",
    currency: "EUR",
    ...overrides,
  };
}

function transactionInput(
  accountId: number,
  overrides: Partial<NewTransaction> = {},
): NewTransaction {
  return {
    accountId,
    providerReference: "ref-1",
    fingerprint: "fp-1",
    status: "booked",
    bookingDate: "2026-05-10",
    valueDate: "2026-05-10",
    transactionDate: null,
    sortDate: "2026-05-10",
    amountMinor: -1250,
    currency: "EUR",
    counterparty: "Caffè Centrale",
    counterpartyAccount: null,
    remittance: "Colazione",
    bankCode: null,
    merchantCategoryCode: null,
    balanceAfterMinor: null,
    searchText: "caffe centrale colazione",
    rawJson: "{}",
    missingCount: 0,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

describe("FinanceRepository", () => {
  let t: TestDatabase;
  let now: number;
  let repo: FinanceRepository;

  beforeEach(() => {
    t = createTestDatabase();
    now = NOW;
    repo = new FinanceRepository(t.db, () => now);
  });
  afterEach(() => t.dispose());

  describe("connections", () => {
    it("creates a connection with defaults and reads it back", () => {
      const id = repo.createConnection(connectionInput());
      expect(repo.getConnection(id)).toEqual({
        id,
        aspspName: "Banca Esempio",
        aspspCountry: "IT",
        aspspLogoUrl: null,
        psuType: "personal",
        providerSessionId: "00000000-0000-4000-8000-000000000001",
        status: "active",
        validUntil: NOW + 90 * DAY,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        statusCheckedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        renewedAt: null,
        removedAt: null,
      });
      expect(repo.getConnection(id + 1)).toBeNull();
    });

    it("updates fields and stamps updatedAt", () => {
      const id = repo.createConnection(connectionInput());
      now += 1_000;
      repo.updateConnection(id, { status: "expired", lastErrorCode: "EXPIRED_SESSION" });
      expect(repo.getConnection(id)).toMatchObject({
        status: "expired",
        lastErrorCode: "EXPIRED_SESSION",
        createdAt: NOW,
        updatedAt: NOW + 1_000,
      });
      expect(() => repo.updateConnection(999, { status: "error" })).toThrow(/does not exist/);
    });

    it("hides removed connections unless asked", () => {
      const kept = repo.createConnection(connectionInput());
      const removed = repo.createConnection(connectionInput({ providerSessionId: "s-2" }));
      repo.updateConnection(removed, { removedAt: now });
      expect(repo.listConnections().map((row) => row.id)).toEqual([kept]);
      expect(repo.listConnections({ includeRemoved: true }).map((row) => row.id)).toEqual([
        kept,
        removed,
      ]);
    });
  });

  describe("accounts", () => {
    it("creates, reads, updates and filters accounts", () => {
      const first = repo.createConnection(connectionInput());
      const second = repo.createConnection(connectionInput({ providerSessionId: "s-2" }));
      const a = repo.createAccount(accountInput(first, { nickname: "Main", iban: "IT00X" }));
      const b = repo.createAccount(
        accountInput(first, { identificationHash: "hash-2", status: "disabled" }),
      );
      const c = repo.createAccount(accountInput(second, { identificationHash: "hash-3" }));

      expect(repo.getAccount(a)).toMatchObject({
        id: a,
        connectionId: first,
        nickname: "Main",
        status: "active",
        bgFetchCount: 0,
        bgFetchDay: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(repo.getAccount(999)).toBeNull();

      expect(repo.listAccounts().map((row) => row.id)).toEqual([a, b, c]);
      expect(repo.listAccounts({ connectionId: first }).map((row) => row.id)).toEqual([a, b]);
      expect(repo.listAccounts({ statuses: ["disabled"] }).map((row) => row.id)).toEqual([b]);
      expect(
        repo
          .listAccounts({ connectionId: first, statuses: ["active", "disabled"] })
          .map((row) => row.id),
      ).toEqual([a, b]);
      expect(repo.listAccounts({ statuses: [] })).toEqual([]);

      now += 500;
      repo.updateAccount(a, { nickname: "Renamed", rateLimitedUntil: now + 6 * 3_600_000 });
      expect(repo.getAccount(a)).toMatchObject({
        nickname: "Renamed",
        rateLimitedUntil: now + 6 * 3_600_000,
        updatedAt: NOW + 500,
      });
      expect(() => repo.updateAccount(999, { nickname: "x" })).toThrow(/does not exist/);
    });

    it("finds accounts by identification hash or IBAN across connections and statuses", () => {
      const first = repo.createConnection(connectionInput());
      const second = repo.createConnection(connectionInput({ providerSessionId: "s-2" }));
      const byHash = repo.createAccount(
        accountInput(first, { identificationHash: "h-a", iban: "IT60A" }),
      );
      const byIban = repo.createAccount(
        accountInput(second, { identificationHash: "h-b", iban: "DE89B", status: "removed" }),
      );
      repo.createAccount(accountInput(second, { identificationHash: "h-c", iban: "FR76C" }));

      expect(repo.findAccountsByIdentity(["h-a"], null).map((row) => row.id)).toEqual([byHash]);
      expect(repo.findAccountsByIdentity(["unknown"], "DE89B").map((row) => row.id)).toEqual([
        byIban,
      ]);
      expect(repo.findAccountsByIdentity(["h-a", "h-x"], "DE89B").map((row) => row.id)).toEqual([
        byHash,
        byIban,
      ]);
      expect(repo.findAccountsByIdentity([], null)).toEqual([]);
      expect(repo.findAccountsByIdentity(["nothing"], "XX00")).toEqual([]);
    });
  });

  describe("tryConsumeBackgroundFetch", () => {
    let accountId: number;
    beforeEach(() => {
      accountId = repo.createAccount(accountInput(repo.createConnection(connectionInput())));
    });

    it("allows exactly `cap` fetches per local day", () => {
      expect(repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 2)).toBe(true);
      expect(repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 2)).toBe(true);
      expect(repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 2)).toBe(false);
      expect(repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 2)).toBe(false);
      expect(repo.getAccount(accountId)).toMatchObject({
        bgFetchDay: "2026-11-09",
        bgFetchCount: 2,
      });
    });

    it("restarts the counter on a new day", () => {
      repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 1);
      expect(repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 1)).toBe(false);
      expect(repo.tryConsumeBackgroundFetch(accountId, "2026-11-10", 1)).toBe(true);
      expect(repo.getAccount(accountId)).toMatchObject({
        bgFetchDay: "2026-11-10",
        bgFetchCount: 1,
      });
      expect(repo.tryConsumeBackgroundFetch(accountId, "2026-11-10", 1)).toBe(false);
    });

    it("honours a cap that was lowered after fetches were counted", () => {
      repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 4);
      repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 4);
      expect(repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 2)).toBe(false);
    });

    it("refuses a cap of zero, even on a new day, and an unknown account", () => {
      expect(repo.tryConsumeBackgroundFetch(accountId, "2026-11-09", 0)).toBe(false);
      expect(repo.getAccount(accountId)).toMatchObject({ bgFetchDay: null, bgFetchCount: 0 });
      expect(repo.tryConsumeBackgroundFetch(999, "2026-11-09", 2)).toBe(false);
    });
  });

  describe("balances", () => {
    let accountId: number;
    beforeEach(() => {
      accountId = repo.createAccount(accountInput(repo.createConnection(connectionInput())));
    });

    const balance = (
      overrides: Partial<Parameters<FinanceRepository["upsertBalance"]>[0]> = {},
    ) => ({
      accountId,
      balanceType: "CLBD",
      amountMinor: 100_000,
      currency: "EUR",
      referenceDate: "2026-11-08",
      asOf: NOW,
      fetchedAt: NOW,
      ...overrides,
    });

    it("replaces the amounts of the same account, type and reference date", () => {
      repo.upsertBalance(balance());
      repo.upsertBalance(balance({ amountMinor: 123_456, asOf: NOW + 10, fetchedAt: NOW + 20 }));
      const rows = repo.latestBalances(accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ amountMinor: 123_456, asOf: NOW + 10, fetchedAt: NOW + 20 });
    });

    it("returns the most recent balance of each type, ordered by type", () => {
      repo.upsertBalance(balance({ referenceDate: "2026-11-07", amountMinor: 1 }));
      repo.upsertBalance(balance({ referenceDate: "2026-11-09", amountMinor: 3 }));
      repo.upsertBalance(balance({ referenceDate: "2026-11-08", amountMinor: 2 }));
      repo.upsertBalance(
        balance({ balanceType: "ITAV", referenceDate: "2026-11-06", amountMinor: 9 }),
      );
      const other = repo.createAccount(
        accountInput(repo.createConnection(connectionInput({ providerSessionId: "s-2" })), {
          identificationHash: "other",
        }),
      );
      repo.upsertBalance(balance({ accountId: other, amountMinor: 777 }));

      expect(
        repo
          .latestBalances(accountId)
          .map((row) => [row.balanceType, row.referenceDate, row.amountMinor]),
      ).toEqual([
        ["CLBD", "2026-11-09", 3],
        ["ITAV", "2026-11-06", 9],
      ]);
      expect(repo.latestBalances(9999)).toEqual([]);
    });

    it("breaks reference-date ties with the as-of time", () => {
      repo.upsertBalance(
        balance({ balanceType: "ITBD", referenceDate: "2026-11-08", asOf: 1, amountMinor: 10 }),
      );
      repo.upsertBalance(
        balance({ balanceType: "ITBD", referenceDate: "2026-11-08", asOf: 2, amountMinor: 20 }),
      );
      expect(repo.latestBalances(accountId)[0]?.amountMinor).toBe(20);
    });

    it("stores negative amounts exactly", () => {
      repo.upsertBalance(balance({ amountMinor: -8_432_045 }));
      expect(repo.latestBalances(accountId)[0]?.amountMinor).toBe(-8_432_045);
    });
  });

  describe("transactions", () => {
    let accountId: number;
    beforeEach(() => {
      accountId = repo.createAccount(accountInput(repo.createConnection(connectionInput())));
    });

    it("round-trips a transaction including the parsed bank code", () => {
      const bankCode = {
        code: "RCDT",
        subCode: "ESCT",
        description: "SEPA credit transfer received",
      };
      const id = repo.insertTransaction(transactionInput(accountId, { bankCode }));
      const rows = repo.transactionsSince(accountId, null);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ ...transactionInput(accountId, { bankCode }), id });
    });

    it("rejects a second row with the same account and fingerprint", () => {
      repo.insertTransaction(transactionInput(accountId));
      expect(() =>
        repo.insertTransaction(transactionInput(accountId, { providerReference: "ref-2" })),
      ).toThrow();
    });

    it("updates fields, including setting and clearing the bank code", () => {
      const id = repo.insertTransaction(
        transactionInput(accountId, { status: "pending", bookingDate: null }),
      );
      repo.updateTransaction(id, {
        status: "booked",
        bookingDate: "2026-05-11",
        bankCode: { code: "ICDT", subCode: null, description: null },
        missingCount: 0,
        lastSeenAt: NOW + 5,
      });
      expect(repo.transactionsSince(accountId, null)[0]).toMatchObject({
        status: "booked",
        bookingDate: "2026-05-11",
        bankCode: { code: "ICDT", subCode: null, description: null },
        lastSeenAt: NOW + 5,
      });
      repo.updateTransaction(id, { bankCode: null });
      expect(repo.transactionsSince(accountId, null)[0]?.bankCode).toBeNull();
      repo.updateTransaction(id, {});
      expect(() => repo.updateTransaction(999, { missingCount: 1 })).toThrow(/does not exist/);
    });

    it("deletes by id and reports how many rows went", () => {
      const a = repo.insertTransaction(transactionInput(accountId, { fingerprint: "a" }));
      const b = repo.insertTransaction(transactionInput(accountId, { fingerprint: "b" }));
      repo.insertTransaction(transactionInput(accountId, { fingerprint: "c" }));
      expect(repo.deleteTransactions([])).toBe(0);
      expect(repo.deleteTransactions([a, b, 999])).toBe(2);
      expect(repo.countTransactions(accountId).total).toBe(1);
    });

    it("lists newest first and honours the start date", () => {
      repo.insertTransaction(
        transactionInput(accountId, { fingerprint: "old", sortDate: "2026-04-01" }),
      );
      const mid = repo.insertTransaction(
        transactionInput(accountId, { fingerprint: "mid", sortDate: "2026-05-01" }),
      );
      const newest = repo.insertTransaction(
        transactionInput(accountId, { fingerprint: "new", sortDate: "2026-05-20" }),
      );
      repo.insertTransaction(
        transactionInput(repo.createAccount(accountInput(1, { identificationHash: "x" })), {
          fingerprint: "other-account",
          sortDate: "2026-05-30",
        }),
      );
      expect(repo.transactionsSince(accountId, null).map((row) => row.fingerprint)).toEqual([
        "new",
        "mid",
        "old",
      ]);
      expect(repo.transactionsSince(accountId, "2026-05-01").map((row) => row.id)).toEqual([
        newest,
        mid,
      ]);
      expect(repo.transactionsSince(accountId, "2026-06-01")).toEqual([]);
    });

    it("finds the last booked date and ignores pending rows", () => {
      expect(repo.lastBookedDate(accountId)).toBeNull();
      repo.insertTransaction(
        transactionInput(accountId, { fingerprint: "a", sortDate: "2026-05-10" }),
      );
      repo.insertTransaction(
        transactionInput(accountId, { fingerprint: "b", sortDate: "2026-05-14" }),
      );
      repo.insertTransaction(
        transactionInput(accountId, {
          fingerprint: "p",
          status: "pending",
          sortDate: "2026-05-20",
          bookingDate: null,
        }),
      );
      expect(repo.lastBookedDate(accountId)).toBe("2026-05-14");
    });

    it("counts totals and pending rows", () => {
      expect(repo.countTransactions(accountId)).toEqual({ total: 0, pending: 0 });
      repo.insertTransaction(transactionInput(accountId, { fingerprint: "a" }));
      repo.insertTransaction(transactionInput(accountId, { fingerprint: "p1", status: "pending" }));
      repo.insertTransaction(transactionInput(accountId, { fingerprint: "p2", status: "pending" }));
      expect(repo.countTransactions(accountId)).toEqual({ total: 3, pending: 2 });
    });
  });

  describe("sync runs", () => {
    let accountId: number;
    beforeEach(() => {
      accountId = repo.createAccount(accountInput(repo.createConnection(connectionInput())));
    });

    it("starts a run, finishes it and lists newest first", () => {
      const first = repo.startSyncRun({ accountId, trigger: "initial" });
      now += 60_000;
      repo.finishSyncRun(first, { status: "succeeded", fetched: 12, inserted: 10, updated: 2 });
      now += 60_000;
      const second = repo.startSyncRun({ accountId, trigger: "manual", withPsuHeaders: true });
      now += 1_000;
      repo.finishSyncRun(second, {
        status: "failed",
        errorCode: "ASPSP_ERROR",
        errorMessage: "The bank returned an error",
      });

      const runs = repo.listSyncRuns(accountId, 10);
      expect(runs.map((run) => run.id)).toEqual([second, first]);
      expect(runs[1]).toMatchObject({
        status: "succeeded",
        trigger: "initial",
        withPsuHeaders: false,
        startedAt: NOW,
        finishedAt: NOW + 60_000,
        fetched: 12,
        inserted: 10,
        updated: 2,
        removed: 0,
      });
      expect(runs[0]).toMatchObject({
        status: "failed",
        withPsuHeaders: true,
        errorCode: "ASPSP_ERROR",
        finishedAt: now,
      });
      expect(repo.listSyncRuns(accountId, 1).map((run) => run.id)).toEqual([second]);
      expect(() => repo.finishSyncRun(999, { status: "failed" })).toThrow(/does not exist/);
    });

    it("records a run that is skipped in one call", () => {
      const id = repo.startSyncRun({
        accountId,
        trigger: "background",
        status: "skipped",
        skipReason: "daily_cap",
        finishedAt: NOW,
      });
      expect(repo.listSyncRuns(accountId, 5)[0]).toMatchObject({
        id,
        status: "skipped",
        skipReason: "daily_cap",
        finishedAt: NOW,
      });
    });

    it("fails the runs left running by a previous process", () => {
      const running = repo.startSyncRun({ accountId, trigger: "background" });
      const done = repo.startSyncRun({ accountId, trigger: "manual" });
      repo.finishSyncRun(done, { status: "succeeded" });
      now += 5_000;
      expect(repo.failStaleSyncRuns("Interrupted by a restart")).toBe(1);
      expect(repo.failStaleSyncRuns("Interrupted by a restart")).toBe(0);
      const byId = new Map(repo.listSyncRuns(accountId, 10).map((run) => [run.id, run]));
      expect(byId.get(running)).toMatchObject({
        status: "failed",
        errorCode: "interrupted",
        errorMessage: "Interrupted by a restart",
        finishedAt: NOW + 5_000,
      });
      expect(byId.get(done)?.status).toBe("succeeded");
    });
  });

  describe("purgeAccount", () => {
    it("removes the account with its data and reports the counts measured before", () => {
      const connectionId = repo.createConnection(connectionInput());
      const accountId = repo.createAccount(accountInput(connectionId));
      const otherId = repo.createAccount(
        accountInput(connectionId, { identificationHash: "hash-2" }),
      );
      repo.insertTransaction(transactionInput(accountId, { fingerprint: "a" }));
      repo.insertTransaction(transactionInput(accountId, { fingerprint: "b" }));
      repo.insertTransaction(transactionInput(otherId, { fingerprint: "a" }));
      repo.upsertBalance({
        accountId,
        balanceType: "CLBD",
        amountMinor: 1,
        currency: "EUR",
        referenceDate: "2026-11-08",
        asOf: NOW,
        fetchedAt: NOW,
      });
      repo.startSyncRun({ accountId, trigger: "initial" });
      repo.startSyncRun({ accountId, trigger: "manual" });
      repo.startSyncRun({ accountId, trigger: "background" });

      expect(repo.purgeAccount(accountId)).toEqual({ transactions: 2, balances: 1, syncRuns: 3 });
      expect(repo.getAccount(accountId)).toBeNull();
      expect(repo.countTransactions(accountId).total).toBe(0);
      expect(repo.latestBalances(accountId)).toEqual([]);
      expect(repo.listSyncRuns(accountId, 10)).toEqual([]);
      expect(repo.countTransactions(otherId).total).toBe(1);
      expect(repo.purgeAccount(accountId)).toEqual({ transactions: 0, balances: 0, syncRuns: 0 });
    });

    it("purges an active account too: status checks belong to the caller", () => {
      const accountId = repo.createAccount(accountInput(repo.createConnection(connectionInput())));
      repo.purgeAccount(accountId);
      expect(repo.getAccount(accountId)).toBeNull();
    });
  });

  describe("authorisation requests", () => {
    const request = (
      overrides: Partial<Parameters<FinanceRepository["createAuthRequest"]>[0]> = {},
    ) => ({
      stateHash: "a".repeat(64),
      purpose: "connect" as const,
      aspspName: "Banca Esempio",
      aspspCountry: "IT",
      validUntil: NOW + 90 * DAY,
      expiresAt: NOW + 600_000,
      ...overrides,
    });

    it("consumes a request exactly once", () => {
      repo.createAuthRequest(request());
      const first = repo.consumeAuthRequest("a".repeat(64));
      expect(first).toMatchObject({
        purpose: "connect",
        connectionId: null,
        aspspName: "Banca Esempio",
        createdAt: NOW,
        consumedAt: NOW,
      });
      expect(repo.consumeAuthRequest("a".repeat(64))).toBeNull();
    });

    it("refuses unknown and expired state hashes", () => {
      repo.createAuthRequest(request({ stateHash: "b".repeat(64), expiresAt: NOW + 1_000 }));
      expect(repo.consumeAuthRequest("c".repeat(64))).toBeNull();
      now += 1_000;
      expect(repo.consumeAuthRequest("b".repeat(64))).toBeNull();
    });

    it("keeps the connection of a renewal request", () => {
      const connectionId = repo.createConnection(connectionInput());
      repo.createAuthRequest(request({ purpose: "renew", connectionId }));
      expect(repo.consumeAuthRequest("a".repeat(64))?.connectionId).toBe(connectionId);
    });

    it("rejects a duplicate state hash", () => {
      repo.createAuthRequest(request());
      expect(() => repo.createAuthRequest(request())).toThrow();
    });

    it("purges the requests past their expiry", () => {
      repo.createAuthRequest(request({ stateHash: "d".repeat(64), expiresAt: NOW + 1_000 }));
      repo.createAuthRequest(request({ stateHash: "e".repeat(64), expiresAt: NOW + 10_000 }));
      now += 2_000;
      expect(repo.purgeExpiredAuthRequests()).toBe(1);
      expect(repo.consumeAuthRequest("e".repeat(64))).not.toBeNull();
    });
  });

  describe("transaction", () => {
    it("commits on success and returns the value", () => {
      const id = repo.transaction(() => repo.createConnection(connectionInput()));
      expect(repo.getConnection(id)).not.toBeNull();
    });

    it("rolls back everything when the callback throws", () => {
      expect(() =>
        repo.transaction(() => {
          repo.createConnection(connectionInput());
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(repo.listConnections({ includeRemoved: true })).toEqual([]);
    });

    it("nests: an inner failure that is caught keeps the outer work", () => {
      repo.transaction(() => {
        repo.createConnection(connectionInput());
        try {
          repo.transaction(() => {
            repo.createConnection(connectionInput({ providerSessionId: "s-2" }));
            throw new Error("inner");
          });
        } catch {
          // The inner savepoint is rolled back; the outer transaction goes on.
        }
      });
      expect(repo.listConnections().map((row) => row.providerSessionId)).toEqual([
        "00000000-0000-4000-8000-000000000001",
      ]);
    });
  });
});
