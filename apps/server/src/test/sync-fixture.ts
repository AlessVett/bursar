import { randomUUID } from "node:crypto";
import type { AccountStatus, ServerEvent, StoredConnectionStatus } from "@bursar/shared";
import { pino } from "pino";
import type { Sqlite } from "../db";
import type { EnableBankingApi, PsuHeaders, TransactionsQuery } from "../eb/client";
import { type EnableBankingError, parseEbErrorBody } from "../eb/errors";
import type {
  EbApplication,
  EbAspsp,
  EbBalance,
  EbSession,
  EbSessionStatus,
  EbStartAuthorizationRequest,
  EbStartAuthorizationResponse,
  EbTransaction,
  EbTransactionsPage,
} from "../eb/schemas";
import { EventBus } from "../events/bus";
import { FinanceRepository } from "../finance/repository";
import type { SyncDeps } from "../finance/sync";
import { JobQueue } from "../jobs/queue";
import { NotificationService } from "../notifications/service";
import { SettingsStore } from "../settings/store";
import { createTestDatabase, type TestDatabase } from "./db";

export const DAY_MS = 86_400_000;
export const SYNC_TEST_TIMEZONE = "Europe/Rome";
/** Monday 9 November 2026, 10:00 in Rome (09:00 UTC). */
export const SYNC_TEST_NOW = Date.UTC(2026, 10, 9, 9, 0, 0);

export interface ConnectionSeed {
  now: number;
  aspspName?: string;
  status?: StoredConnectionStatus;
  validUntil?: number;
  removedAt?: number | null;
}

/** Inserts a bank connection with raw SQL (column names from the M1 schema). */
export function insertConnection(sqlite: Sqlite, seed: ConnectionSeed): number {
  const result = sqlite
    .prepare(
      `INSERT INTO bank_connections
         (aspsp_name, aspsp_country, psu_type, provider_session_id, status, valid_until,
          created_at, updated_at, removed_at)
       VALUES (?, 'IT', 'personal', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.aspspName ?? "Banca Esempio",
      randomUUID(),
      seed.status ?? "active",
      seed.validUntil ?? seed.now + 90 * DAY_MS,
      seed.now,
      seed.now,
      seed.removedAt ?? null,
    );
  return Number(result.lastInsertRowid);
}

export interface AccountSeed {
  connectionId: number;
  now: number;
  /** `undefined` generates a uid; `null` stores none. */
  providerAccountUid?: string | null;
  status?: AccountStatus;
  currency?: string;
  rateLimitedUntil?: number | null;
}

/** Inserts an account with raw SQL (column names from the M1 schema). */
export function insertAccount(sqlite: Sqlite, seed: AccountSeed): number {
  const result = sqlite
    .prepare(
      `INSERT INTO accounts
         (connection_id, provider_account_uid, identification_hash, masked_identifier, last4,
          product, currency, cash_account_type, status, rate_limited_until, created_at, updated_at)
       VALUES (?, ?, ?, '•••• 0042', '0042', 'Conto Esempio', ?, 'CACC', ?, ?, ?, ?)`,
    )
    .run(
      seed.connectionId,
      seed.providerAccountUid === undefined ? randomUUID() : seed.providerAccountUid,
      `test-identification-${randomUUID()}`,
      seed.currency ?? "EUR",
      seed.status ?? "active",
      seed.rateLimitedUntil ?? null,
      seed.now,
      seed.now,
    );
  return Number(result.lastInsertRowid);
}

export const BALANCES: EbBalance[] = [
  {
    name: "Closing booked balance",
    balance_amount: { currency: "EUR", amount: "1520.40" },
    balance_type: "CLBD",
    last_change_date_time: "2026-11-08T18:00:00Z",
    reference_date: "2026-11-08",
  },
  {
    name: "Interim available balance",
    balance_amount: { currency: "EUR", amount: "1490.15" },
    balance_type: "ITAV",
    last_change_date_time: "2026-11-09T07:30:00Z",
    reference_date: "2026-11-09",
  },
];

export const SALARY: EbTransaction = {
  entry_reference: "ENTRY-0001",
  transaction_id: "tx-0001",
  transaction_amount: { currency: "EUR", amount: "2350.00" },
  credit_debit_indicator: "CRDT",
  status: "BOOK",
  booking_date: "2026-11-06",
  value_date: "2026-11-06",
  transaction_date: "2026-11-06",
  debtor: { name: "Example Employer Srl" },
  remittance_information: ["Salary November 2026"],
  bank_transaction_code: { description: "Credit transfer", code: "RCDT", sub_code: "ESCT" },
};

export const GROCERIES: EbTransaction = {
  entry_reference: "ENTRY-0002",
  transaction_id: "tx-0002",
  transaction_amount: { currency: "EUR", amount: "42.80" },
  credit_debit_indicator: "DBIT",
  status: "BOOK",
  booking_date: "2026-11-07",
  value_date: "2026-11-07",
  creditor: { name: "Market Esempio" },
  remittance_information: ["Card payment"],
  merchant_category_code: "5411",
};

export const PENDING_COFFEE: EbTransaction = {
  entry_reference: null,
  transaction_id: null,
  transaction_amount: { currency: "EUR", amount: "3.20" },
  credit_debit_indicator: "DBIT",
  status: "PDNG",
  booking_date: null,
  value_date: null,
  transaction_date: "2026-11-09",
  creditor: { name: "Bar Centrale" },
  remittance_information: ["Card payment"],
};

/** Two pages, newest first, like the Mock ASPSP. */
export const PAGE_1: EbTransactionsPage = {
  transactions: [PENDING_COFFEE, GROCERIES],
  continuation_key: "page-2",
};
export const PAGE_2: EbTransactionsPage = { transactions: [SALARY], continuation_key: null };

/** An `EnableBankingError` built from an error body shaped like `eb-api-notes.md` §9. */
export function ebError(status: number, code: string, message: string): EnableBankingError {
  return parseEbErrorBody(status, { message, code: status, error: code });
}

/** Scripted bank: balances and paged transactions, queued errors, recorded calls. */
export class StubBank implements EnableBankingApi {
  balances: EbBalance[] = BALANCES;
  pages: EbTransactionsPage[] = [PAGE_1, PAGE_2];
  /** Replaces the page lookup when set (pagination guard tests). */
  transactionsImpl: ((query: TransactionsQuery) => EbTransactionsPage) | null = null;
  readonly balanceErrors: EnableBankingError[] = [];
  readonly transactionErrors: EnableBankingError[] = [];
  readonly balanceCalls: { accountUid: string; psu: PsuHeaders | undefined }[] = [];
  readonly transactionCalls: {
    accountUid: string;
    query: TransactionsQuery;
    psu: PsuHeaders | undefined;
  }[] = [];

  async getBalances(accountUid: string, psu?: PsuHeaders): Promise<EbBalance[]> {
    this.balanceCalls.push({ accountUid, psu });
    const error = this.balanceErrors.shift();
    if (error) throw error;
    return this.balances;
  }

  async getTransactions(
    accountUid: string,
    query: TransactionsQuery,
    psu?: PsuHeaders,
  ): Promise<EbTransactionsPage> {
    this.transactionCalls.push({ accountUid, query: { ...query }, psu });
    const error = this.transactionErrors.shift();
    if (error) throw error;
    if (this.transactionsImpl) return this.transactionsImpl(query);
    const index = query.continuationKey
      ? Number(query.continuationKey.slice("page-".length)) - 1
      : 0;
    return this.pages[index] ?? { transactions: [], continuation_key: null };
  }

  async getApplication(): Promise<EbApplication> {
    throw new Error("getApplication is not used by the sync");
  }

  async listAspsps(_country: string): Promise<EbAspsp[]> {
    throw new Error("listAspsps is not used by the sync");
  }

  async startAuthorization(
    _request: EbStartAuthorizationRequest,
  ): Promise<EbStartAuthorizationResponse> {
    throw new Error("startAuthorization is not used by the sync");
  }

  async createSession(_code: string): Promise<EbSession> {
    throw new Error("createSession is not used by the sync");
  }

  async getSession(_sessionId: string): Promise<EbSessionStatus> {
    throw new Error("getSession is not used by the sync");
  }

  async deleteSession(_sessionId: string): Promise<void> {
    throw new Error("deleteSession is not used by the sync");
  }
}

/** Narrows the recorded bus events to one type. */
export function eventsOf<T extends ServerEvent["type"]>(
  events: readonly ServerEvent[],
  type: T,
): Extract<ServerEvent, { type: T }>[] {
  return events.filter((event): event is Extract<ServerEvent, { type: T }> => event.type === type);
}

export interface SyncHarness {
  t: TestDatabase;
  repo: FinanceRepository;
  queue: JobQueue;
  bus: EventBus;
  settings: SettingsStore;
  notifications: NotificationService;
  bank: StubBank;
  /** Every event published on the bus, in order. */
  events: ServerEvent[];
  /** Mutable clock shared by every component. */
  clock: { now: number };
  deps: SyncDeps;
  dispose(): void;
}

/** Real database, repository, queue, bus, settings and notifications; a scripted bank. */
export function createSyncHarness(start: number = SYNC_TEST_NOW): SyncHarness {
  const t = createTestDatabase();
  const clock = { now: start };
  const now = () => clock.now;
  const repo = new FinanceRepository(t.db, now);
  const queue = new JobQueue(t.sqlite, now);
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => {
    events.push(event);
  });
  const settings = new SettingsStore(t.db, now);
  const notifications = new NotificationService({
    db: t.db,
    queue,
    bus,
    settings,
    emailEnabled: () => false,
    now,
  });
  const bank = new StubBank();
  const deps: SyncDeps = {
    repo,
    api: bank,
    bus,
    notifications,
    settings,
    timezone: SYNC_TEST_TIMEZONE,
    now,
    logger: pino({ level: "silent" }),
  };
  return {
    t,
    repo,
    queue,
    bus,
    settings,
    notifications,
    bank,
    events,
    clock,
    deps,
    dispose: () => t.dispose(),
  };
}
