import {
  accountDisplayName,
  effectiveConnectionStatus,
  isIncludedInTotals,
  isValidIban,
  pickPreferredBalance,
} from "@bursar/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { FinanceRepository } from "../finance/repository";
import type { SeedContext } from "../server";
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from "../test/db";
import { seedBanking } from "./seed-banking";
import { QA_SEEDERS } from "./seeders";

const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
const TIME_ZONE = "Europe/Rome";

function contextFor(t: TestDatabase, now = NOW): SeedContext {
  const config = loadConfig({
    BURSAR_PUBLIC_URL: "https://bursar.example.test",
    TZ: TIME_ZONE,
    BURSAR_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
    BURSAR_DATA_DIR: t.dir,
    BURSAR_MIGRATIONS_DIR: MIGRATIONS_DIR,
  });
  return { db: t.db, sqlite: t.sqlite, config, now: () => now };
}

function dump(t: TestDatabase): Record<string, unknown[]> {
  const tables = [
    "bank_connections",
    "accounts",
    "balances",
    "transactions",
    "sync_runs",
    "notifications",
    "backup_runs",
  ];
  return Object.fromEntries(
    tables.map((table) => [table, t.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]),
  );
}

describe("seedBanking", () => {
  let t: TestDatabase;
  let repo: FinanceRepository;

  // The seed is read-only for every test below, so it runs once.
  beforeAll(() => {
    t = createTestDatabase();
    repo = new FinanceRepository(t.db, () => NOW);
    seedBanking(contextFor(t));
  });
  afterAll(() => t.dispose());

  it("is registered as a QA seeder", () => {
    expect(QA_SEEDERS).toContain(seedBanking);
  });

  it("makes account 1 an active EUR current account on an active connection", () => {
    const account = repo.getAccount(1);
    expect(account).toMatchObject({ status: "active", currency: "EUR", cashAccountType: "CACC" });
    const connection = repo.getConnection(account?.connectionId ?? 0);
    expect(connection).toMatchObject({ aspspName: "Banca Esempio", status: "active" });
    expect(
      effectiveConnectionStatus(
        connection?.status ?? "error",
        connection?.validUntil ?? 0,
        NOW,
        TIME_ZONE,
      ),
    ).toBe("active");
    expect(
      repo.listAccounts({ connectionId: connection?.id }).filter((a) => a.currency === "EUR"),
    ).toHaveLength(2);
  });

  it("covers every connection state", () => {
    const states = repo
      .listConnections()
      .map((c) => effectiveConnectionStatus(c.status, c.validUntil, NOW, TIME_ZONE))
      .sort();
    expect(states).toEqual(["active", "error", "expired", "expiring", "revoked"]);

    const expiring = repo
      .listConnections()
      .find(
        (c) => effectiveConnectionStatus(c.status, c.validUntil, NOW, TIME_ZONE) === "expiring",
      );
    expect(expiring).toMatchObject({ aspspName: "Northwind Bank", status: "active" });

    const removed = repo
      .listConnections({ includeRemoved: true })
      .filter((c) => c.removedAt !== null);
    expect(removed).toHaveLength(1);
  });

  it("covers every account state and mixed currencies", () => {
    const accounts = repo.listAccounts();
    const countBy = (status: string): number => accounts.filter((a) => a.status === status).length;
    expect(accounts).toHaveLength(10);
    expect(countBy("active")).toBe(7);
    expect(countBy("disabled")).toBe(1);
    expect(countBy("unavailable")).toBe(1);
    expect(countBy("removed")).toBe(1);
    expect(new Set(accounts.map((a) => a.currency))).toEqual(new Set(["EUR", "USD"]));
    expect(accounts.filter((a) => isIncludedInTotals(a.status))).toHaveLength(8);
    expect(
      accounts.filter((a) => a.rateLimitedUntil !== null && a.rateLimitedUntil > NOW),
    ).toHaveLength(1);
    expect(accounts.filter((a) => a.bgFetchCount >= 2 && a.bgFetchDay !== null)).toHaveLength(2);
    expect(accounts.filter((a) => a.providerAccountUid === null)).toHaveLength(1);
    expect(accounts.some((a) => a.nickname !== null)).toBe(true);
    const savings = repo.getAccount(2);
    expect(savings).not.toBeNull();
    if (savings) expect(accountDisplayName(savings, "en")).toBe("Fondo emergenza");
  });

  it("uses generated IBANs with valid check digits and masked display values", () => {
    const withIban = repo.listAccounts().filter((a) => a.iban !== null);
    expect(withIban).toHaveLength(9);
    for (const account of withIban) {
      expect(isValidIban(account.iban ?? "")).toBe(true);
      expect(account.maskedIdentifier).toContain("••");
      expect(account.maskedIdentifier).not.toContain(account.iban ?? "never");
      expect(account.last4).toBe(account.iban?.slice(-4));
    }
    const usd = repo.listAccounts().find((a) => a.currency === "USD");
    expect(usd?.iban).toBeNull();
    expect(usd?.maskedIdentifier).toBe("•••• 4821");
  });

  it("gives account 1 about 120 days of history with pending, coded and uncoded rows", () => {
    const rows = repo.transactionsSince(1, null);
    expect(rows.length).toBeGreaterThan(110);
    expect(rows.length).toBeLessThan(260);
    expect(repo.countTransactions(1).pending).toBe(3);
    expect(rows.filter((r) => r.status === "pending").every((r) => r.bookingDate === null)).toBe(
      true,
    );
    expect(rows.some((r) => r.bankCode?.code === "RCDT")).toBe(true);
    expect(rows.some((r) => (r.remittance ?? "").includes("Rif."))).toBe(true);
    expect(rows.some((r) => r.providerReference === null && r.status === "booked")).toBe(true);
    expect(rows.some((r) => r.counterparty === null)).toBe(true);
    expect(rows.some((r) => r.amountMinor > 0)).toBe(true);
    expect(rows.every((r) => Number.isSafeInteger(r.amountMinor))).toBe(true);
    const oldest = rows.at(-1)?.sortDate ?? "";
    expect(oldest >= "2026-07-13" && oldest <= "2026-07-20").toBe(true);
    expect(JSON.parse(rows[0]?.rawJson ?? "null")).toHaveProperty(
      "transaction_amount.currency",
      "EUR",
    );
  });

  it("reconciles the balance history with the ledger of account 1", () => {
    const latest = repo.latestBalances(1);
    expect(latest.map((b) => b.balanceType)).toEqual(["CLBD", "ITAV"]);
    const closing = latest.find((b) => b.balanceType === "CLBD");
    const available = latest.find((b) => b.balanceType === "ITAV");
    expect(closing?.amountMinor).toBe(428_015);
    expect(closing?.referenceDate).toBe("2026-11-09");
    const pending = repo
      .transactionsSince(1, null)
      .filter((r) => r.status === "pending")
      .reduce((sum, r) => sum + r.amountMinor, 0);
    expect(available?.amountMinor).toBe(428_015 + pending);
    expect(pickPreferredBalance(latest)?.balanceType).toBe("CLBD");

    const history = t.sqlite
      .prepare("SELECT count(*) AS n FROM balances WHERE account_id = 1 AND balance_type = 'CLBD'")
      .get() as { n: number };
    expect(history.n).toBe(120);

    const lastBooked = repo.transactionsSince(1, null).find((r) => r.status === "booked");
    expect(lastBooked?.balanceAfterMinor).toBe(428_015);
  });

  it("keeps the foreign-currency account in its own currency", () => {
    const usd = repo.listAccounts().find((a) => a.currency === "USD");
    const rows = repo.transactionsSince(usd?.id ?? 0, null);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => r.currency === "USD")).toBe(true);
    expect(repo.latestBalances(usd?.id ?? 0)[0]).toMatchObject({
      currency: "USD",
      balanceType: "ITAV",
    });
  });

  it("keeps transactions on the removed and disabled accounts", () => {
    const removed = repo.listAccounts({ statuses: ["removed"] })[0];
    const disabled = repo.listAccounts({ statuses: ["disabled"] })[0];
    expect(repo.countTransactions(removed?.id ?? 0).total).toBeGreaterThan(5);
    expect(repo.countTransactions(disabled?.id ?? 0).total).toBe(6);
  });

  it("makes the expired connection's account stale and the loan negative", () => {
    const stale = repo.listAccounts().find((a) => a.product === "Conto Libero");
    expect(NOW - (stale?.lastSyncedAt ?? NOW)).toBeGreaterThan(72 * 3_600_000);
    const loan = repo.listAccounts().find((a) => a.cashAccountType === "LOAN");
    expect(repo.latestBalances(loan?.id ?? 0)[0]?.amountMinor).toBeLessThan(0);
  });

  it("records succeeded, failed and skipped sync runs, with every skip reason", () => {
    const runs = repo.listAccounts().flatMap((a) => repo.listSyncRuns(a.id, 50));
    const count = (status: string): number => runs.filter((r) => r.status === status).length;
    expect(count("running")).toBe(0);
    expect(count("failed")).toBe(7);
    expect(count("succeeded")).toBeGreaterThan(10);
    expect(new Set(runs.filter((r) => r.status === "skipped").map((r) => r.skipReason))).toEqual(
      new Set([
        "rate_limited",
        "daily_cap",
        "connection_inactive",
        "account_inactive",
        "no_provider_uid",
      ]),
    );
    expect(runs.some((r) => r.withPsuHeaders)).toBe(true);
    expect(
      runs.filter((r) => r.status === "failed").every((r) => r.errorCode && r.errorMessage),
    ).toBe(true);
    expect(runs.every((r) => r.finishedAt !== null && r.finishedAt >= r.startedAt)).toBe(true);
    const failing = repo.listAccounts().find((a) => a.product === "Compte Courant");
    expect(
      repo
        .listSyncRuns(failing?.id ?? 0, 10)
        .slice(0, 4)
        .map((r) => r.status),
    ).toEqual(["failed", "failed", "failed", "failed"]);
  });

  it("adds two notifications, one unread, and a successful backup run", () => {
    const rows = t.sqlite
      .prepare("SELECT event, read_at AS readAt FROM notifications ORDER BY id")
      .all() as {
      event: string;
      readAt: number | null;
    }[];
    expect(rows.map((r) => r.event)).toEqual(["consent_expiring", "sync_failing"]);
    expect(rows.filter((r) => r.readAt === null)).toHaveLength(1);
    const backups = t.sqlite
      .prepare("SELECT status, target, size_bytes AS size FROM backup_runs")
      .all();
    expect(backups).toEqual([{ status: "succeeded", target: "local", size: 1_843_200 }]);
  });

  it("holds only fictional data", () => {
    const text = JSON.stringify(dump(t));
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("is identical across two runs with the same clock", () => {
    const other = createTestDatabase();
    try {
      seedBanking(contextFor(other));
      expect(dump(other)).toEqual(dump(t));
    } finally {
      other.dispose();
    }
  });

  it("moves with the clock but keeps the same shape", () => {
    const other = createTestDatabase();
    try {
      seedBanking(contextFor(other, NOW + 30 * 86_400_000));
      const shifted = new FinanceRepository(other.db, () => NOW + 30 * 86_400_000);
      expect(shifted.listAccounts()).toHaveLength(10);
      expect(shifted.countTransactions(1).pending).toBe(3);
      const states = shifted
        .listConnections()
        .map((c) =>
          effectiveConnectionStatus(c.status, c.validUntil, NOW + 30 * 86_400_000, TIME_ZONE),
        )
        .sort();
      expect(states).toEqual(["active", "error", "expired", "expiring", "revoked"]);
    } finally {
      other.dispose();
    }
  });
});
