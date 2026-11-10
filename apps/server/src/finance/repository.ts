import type {
  AccountStatus,
  LocalDate,
  SkipReason,
  SyncRunStatus,
  SyncTrigger,
} from "@bursar/shared";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { BursarDb } from "../db";
import {
  accounts,
  balances,
  bankAuthRequests,
  bankConnections,
  syncRuns,
  transactions,
} from "../db/schema";

/** The bank's own classification of a transaction (ISO 20022 style), as the sync stores it. */
export interface BankTransactionCode {
  code: string | null;
  subCode: string | null;
  description: string | null;
}

export type ConnectionRow = typeof bankConnections.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type BalanceRow = typeof balances.$inferSelect;
export type TransactionRow = Omit<typeof transactions.$inferSelect, "bankCode"> & {
  bankCode: BankTransactionCode | null;
};
export type SyncRunRow = typeof syncRuns.$inferSelect;
export type AuthRequestRow = typeof bankAuthRequests.$inferSelect;

type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** `status` defaults to `active`, `psuType` to `personal`, timestamps to the repository clock. */
export type NewConnection = WithOptional<
  Omit<ConnectionRow, "id">,
  | "aspspLogoUrl"
  | "psuType"
  | "status"
  | "lastErrorCode"
  | "lastErrorMessage"
  | "lastErrorAt"
  | "statusCheckedAt"
  | "createdAt"
  | "updatedAt"
  | "renewedAt"
  | "removedAt"
>;

/** Only the connection, the identification hash and the currency are required. */
export type NewAccount = Pick<AccountRow, "connectionId" | "identificationHash" | "currency"> &
  Partial<Omit<AccountRow, "id" | "connectionId" | "identificationHash" | "currency">>;

export type NewBalance = Omit<BalanceRow, "id">;

export type NewTransaction = Omit<TransactionRow, "id">;

export interface NewSyncRun {
  accountId: number;
  trigger: SyncTrigger;
  withPsuHeaders?: boolean;
  startedAt?: number;
  /** Defaults to `running`; a run that is recorded already finished (for example skipped) sets all of these. */
  status?: SyncRunStatus;
  skipReason?: SkipReason | null;
  finishedAt?: number | null;
}

export interface NewAuthRequest {
  stateHash: string;
  purpose: AuthRequestRow["purpose"];
  connectionId?: number | null;
  aspspName: string;
  aspspCountry: string;
  validUntil: number;
  expiresAt: number;
  createdAt?: number;
}

function parseBankCode(value: string | null): BankTransactionCode | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const text = (key: string): string | null =>
      typeof record[key] === "string" ? (record[key] as string) : null;
    return { code: text("code"), subCode: text("subCode"), description: text("description") };
  } catch {
    return null;
  }
}

function toTransactionRow(row: typeof transactions.$inferSelect): TransactionRow {
  return { ...row, bankCode: parseBankCode(row.bankCode) };
}

function hasValues(values: Record<string, unknown>): boolean {
  return Object.values(values).some((value) => value !== undefined);
}

export class FinanceRepository {
  constructor(
    private readonly db: BursarDb,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Runs `fn` in one SQLite transaction (a savepoint when already inside one). `fn` must be
   * synchronous: the database driver is synchronous and a returned promise would escape the
   * transaction.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(() => fn());
  }

  // Connections

  createConnection(input: NewConnection): number {
    const now = this.now();
    const row = this.db
      .insert(bankConnections)
      .values({ ...input, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now })
      .returning({ id: bankConnections.id })
      .get();
    return row.id;
  }

  getConnection(id: number): ConnectionRow | null {
    return this.db.select().from(bankConnections).where(eq(bankConnections.id, id)).get() ?? null;
  }

  /** Connections the owner has not removed, oldest first; `includeRemoved` adds the removed ones. */
  listConnections(options: { includeRemoved?: boolean } = {}): ConnectionRow[] {
    return this.db
      .select()
      .from(bankConnections)
      .where(options.includeRemoved ? undefined : isNull(bankConnections.removedAt))
      .orderBy(asc(bankConnections.id))
      .all();
  }

  updateConnection(id: number, patch: Partial<Omit<ConnectionRow, "id" | "createdAt">>): void {
    const result = this.db
      .update(bankConnections)
      .set({ ...patch, updatedAt: patch.updatedAt ?? this.now() })
      .where(eq(bankConnections.id, id))
      .run();
    if (result.changes === 0) throw new Error(`Connection ${id} does not exist`);
  }

  /**
   * Deletes a connection row; its pending `bank_auth_requests` cascade. Throws (foreign key) while
   * accounts still reference it, so callers delete or purge the accounts first.
   */
  deleteConnection(id: number): boolean {
    return this.db.delete(bankConnections).where(eq(bankConnections.id, id)).run().changes > 0;
  }

  // Accounts

  createAccount(input: NewAccount): number {
    const now = this.now();
    const row = this.db
      .insert(accounts)
      .values({ ...input, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now })
      .returning({ id: accounts.id })
      .get();
    return row.id;
  }

  getAccount(id: number): AccountRow | null {
    return this.db.select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
  }

  /** Accounts in creation order; without a filter every account including removed ones. */
  listAccounts(
    filter: { connectionId?: number; statuses?: readonly AccountStatus[] } = {},
  ): AccountRow[] {
    const conditions = [];
    if (filter.connectionId !== undefined) {
      conditions.push(eq(accounts.connectionId, filter.connectionId));
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return [];
      conditions.push(inArray(accounts.status, [...filter.statuses]));
    }
    return this.db
      .select()
      .from(accounts)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(accounts.id))
      .all();
  }

  updateAccount(id: number, patch: Partial<Omit<AccountRow, "id" | "createdAt">>): void {
    const result = this.db
      .update(accounts)
      .set({ ...patch, updatedAt: patch.updatedAt ?? this.now() })
      .where(eq(accounts.id, id))
      .run();
    if (result.changes === 0) throw new Error(`Account ${id} does not exist`);
  }

  /**
   * Accounts (of any status, on any connection) whose identification hash is one of the given
   * hashes or whose IBAN equals `iban`. Callers pass the IBAN already normalised.
   */
  findAccountsByIdentity(
    identificationHashes: readonly string[],
    iban: string | null,
  ): AccountRow[] {
    const matches = [];
    if (identificationHashes.length > 0) {
      matches.push(inArray(accounts.identificationHash, [...identificationHashes]));
    }
    if (iban !== null) matches.push(eq(accounts.iban, iban));
    if (matches.length === 0) return [];
    return this.db
      .select()
      .from(accounts)
      .where(or(...matches))
      .orderBy(asc(accounts.id))
      .all();
  }

  /**
   * Claims one unattended (background) bank fetch for the account on `localDate`. One atomic
   * statement: the counter restarts at 1 on a new day and the claim is refused once `cap`
   * fetches were already claimed that day, so concurrent callers can never exceed the cap.
   */
  tryConsumeBackgroundFetch(accountId: number, localDate: LocalDate, cap: number): boolean {
    const claimed = this.db
      .update(accounts)
      .set({
        bgFetchCount: sql`CASE WHEN bg_fetch_day IS ${localDate} THEN bg_fetch_count + 1 ELSE 1 END`,
        bgFetchDay: localDate,
      })
      .where(
        and(
          eq(accounts.id, accountId),
          sql`${cap} > 0`,
          sql`(bg_fetch_day IS NOT ${localDate} OR bg_fetch_count < ${cap})`,
        ),
      )
      .returning({ id: accounts.id })
      .get();
    return claimed !== undefined;
  }

  // Balances

  /** Inserts the balance, or replaces the amounts of the same account, type and reference date. */
  upsertBalance(input: NewBalance): void {
    this.db
      .insert(balances)
      .values(input)
      .onConflictDoUpdate({
        target: [balances.accountId, balances.balanceType, balances.referenceDate],
        set: {
          amountMinor: input.amountMinor,
          currency: input.currency,
          asOf: input.asOf,
          fetchedAt: input.fetchedAt,
        },
      })
      .run();
  }

  /** The most recent balance of each type (by reference date, then as-of time), ordered by type. */
  latestBalances(accountId: number): BalanceRow[] {
    return this.db
      .select()
      .from(balances)
      .where(
        and(
          eq(balances.accountId, accountId),
          eq(
            balances.id,
            sql`(SELECT newer.id FROM balances AS newer
                 WHERE newer.account_id = ${balances.accountId}
                   AND newer.balance_type = ${balances.balanceType}
                 ORDER BY newer.reference_date DESC, newer.as_of DESC, newer.id DESC
                 LIMIT 1)`,
          ),
        ),
      )
      .orderBy(asc(balances.balanceType))
      .all();
  }

  // Transactions

  insertTransaction(input: NewTransaction): number {
    const row = this.db
      .insert(transactions)
      .values({ ...input, bankCode: input.bankCode ? JSON.stringify(input.bankCode) : null })
      .returning({ id: transactions.id })
      .get();
    return row.id;
  }

  updateTransaction(id: number, patch: Partial<Omit<TransactionRow, "id" | "accountId">>): void {
    const { bankCode, ...rest } = patch;
    const values: Partial<typeof transactions.$inferInsert> = { ...rest };
    if (bankCode !== undefined) values.bankCode = bankCode ? JSON.stringify(bankCode) : null;
    if (!hasValues(values)) return;
    const result = this.db.update(transactions).set(values).where(eq(transactions.id, id)).run();
    if (result.changes === 0) throw new Error(`Transaction ${id} does not exist`);
  }

  deleteTransactions(ids: readonly number[]): number {
    if (ids.length === 0) return 0;
    return this.db
      .delete(transactions)
      .where(inArray(transactions.id, [...ids]))
      .run().changes;
  }

  /** Newest first; `fromDate` keeps rows whose sort date is on or after it. */
  transactionsSince(accountId: number, fromDate: LocalDate | null): TransactionRow[] {
    return this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, accountId),
          fromDate === null ? undefined : gte(transactions.sortDate, fromDate),
        ),
      )
      .orderBy(desc(transactions.sortDate), desc(transactions.id))
      .all()
      .map(toTransactionRow);
  }

  /** The newest sort date among booked transactions, or null when there are none. */
  lastBookedDate(accountId: number): LocalDate | null {
    const row = this.db
      .select({ latest: sql<string | null>`max(${transactions.sortDate})` })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), eq(transactions.status, "booked")))
      .get();
    return row?.latest ?? null;
  }

  countTransactions(accountId: number): { total: number; pending: number } {
    const row = this.db
      .select({
        total: count(),
        pending: sql<number>`coalesce(sum(CASE WHEN ${transactions.status} = 'pending' THEN 1 ELSE 0 END), 0)`,
      })
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
      .get();
    return { total: Number(row?.total ?? 0), pending: Number(row?.pending ?? 0) };
  }

  // Sync runs

  startSyncRun(input: NewSyncRun): number {
    const row = this.db
      .insert(syncRuns)
      .values({
        accountId: input.accountId,
        trigger: input.trigger,
        status: input.status ?? "running",
        skipReason: input.skipReason ?? null,
        withPsuHeaders: input.withPsuHeaders ?? false,
        startedAt: input.startedAt ?? this.now(),
        finishedAt: input.finishedAt ?? null,
      })
      .returning({ id: syncRuns.id })
      .get();
    return row.id;
  }

  /** Applies the patch and stamps `finishedAt` with the repository clock unless the patch sets it. */
  finishSyncRun(
    id: number,
    patch: Partial<Omit<SyncRunRow, "id" | "accountId" | "trigger" | "startedAt">>,
  ): void {
    const result = this.db
      .update(syncRuns)
      .set({ ...patch, finishedAt: patch.finishedAt ?? this.now() })
      .where(eq(syncRuns.id, id))
      .run();
    if (result.changes === 0) throw new Error(`Sync run ${id} does not exist`);
  }

  /** Newest first. */
  listSyncRuns(accountId: number, limit: number): SyncRunRow[] {
    return this.db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.accountId, accountId))
      .orderBy(desc(syncRuns.startedAt), desc(syncRuns.id))
      .limit(limit)
      .all();
  }

  /** Marks every run still `running` as failed (the process that ran it is gone). */
  failStaleSyncRuns(message: string): number {
    return this.db
      .update(syncRuns)
      .set({
        status: "failed",
        errorCode: "interrupted",
        errorMessage: message,
        finishedAt: this.now(),
      })
      .where(eq(syncRuns.status, "running"))
      .run().changes;
  }

  /**
   * Deletes the account; its transactions, balances and sync runs go with it through the foreign
   * keys. Returns the counts measured before the delete. It does not check the account status:
   * callers decide whether a purge is allowed.
   */
  purgeAccount(accountId: number): { transactions: number; balances: number; syncRuns: number } {
    return this.transaction(() => {
      const countRows = (table: typeof transactions | typeof balances | typeof syncRuns): number =>
        Number(
          this.db.select({ n: count() }).from(table).where(eq(table.accountId, accountId)).get()
            ?.n ?? 0,
        );
      const removed = {
        transactions: countRows(transactions),
        balances: countRows(balances),
        syncRuns: countRows(syncRuns),
      };
      this.db.delete(accounts).where(eq(accounts.id, accountId)).run();
      return removed;
    });
  }

  // Authorisation requests

  createAuthRequest(input: NewAuthRequest): number {
    const row = this.db
      .insert(bankAuthRequests)
      .values({
        ...input,
        connectionId: input.connectionId ?? null,
        createdAt: input.createdAt ?? this.now(),
      })
      .returning({ id: bankAuthRequests.id })
      .get();
    return row.id;
  }

  /**
   * Returns the request for this state hash and marks it consumed, or null when the hash is
   * unknown, already consumed or expired. One atomic statement: a state value works once.
   */
  consumeAuthRequest(stateHash: string): AuthRequestRow | null {
    const now = this.now();
    return (
      this.db
        .update(bankAuthRequests)
        .set({ consumedAt: now })
        .where(
          and(
            eq(bankAuthRequests.stateHash, stateHash),
            isNull(bankAuthRequests.consumedAt),
            gt(bankAuthRequests.expiresAt, now),
          ),
        )
        .returning()
        .get() ?? null
    );
  }

  /** Deletes the requests past their expiry, consumed or not. */
  purgeExpiredAuthRequests(): number {
    return this.db.delete(bankAuthRequests).where(lte(bankAuthRequests.expiresAt, this.now())).run()
      .changes;
  }
}
