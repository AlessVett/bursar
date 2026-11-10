import type {
  AccountStatus,
  SkipReason,
  StoredConnectionStatus,
  SyncRunStatus,
} from "@bursar/shared";
import { AuditLog } from "../audit";
import type { EnableBankingApi } from "../eb/client";
import sessionStatusFixture from "../eb/fixtures/session-status.json";
import type { EbSessionStatus } from "../eb/schemas";
import { FinanceRepository } from "../finance/repository";
import { createNotificationFixture, type NotificationFixture } from "./notifications";

/** 2026-11-09 10:00 in Europe/Rome (UTC+1 in November, no DST change in the following weeks). */
export const NOW = Date.UTC(2026, 10, 9, 9, 0);
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const TIMEZONE = "Europe/Rome";
/** A fictional Enable Banking session id (uuid4 shape). */
export const SESSION_ID = "1c7a9d42-5b8e-4f0a-9d3c-2e6f8a1b4c70";
export const BANK_NAME = "Banca Esempio";

export interface LifecycleFixture extends NotificationFixture {
  repo: FinanceRepository;
  audit: AuditLog;
}

/** Task 9's notification fixture (real DB, queue, bus, settings, service) plus repository and audit log. */
export function createLifecycleFixture(): LifecycleFixture {
  const fx = createNotificationFixture();
  fx.clock.now = NOW;
  const now = () => fx.clock.now;
  return Object.assign(fx, {
    repo: new FinanceRepository(fx.t.db, now),
    audit: new AuditLog(fx.t.db, now),
  });
}

function unexpected(method: keyof EnableBankingApi): () => Promise<never> {
  return () => Promise.reject(new Error(`Unexpected Enable Banking call: ${method}`));
}

/** An `EnableBankingApi` whose methods reject unless overridden. */
export function stubBankingApi(overrides: Partial<EnableBankingApi> = {}): EnableBankingApi {
  return {
    getApplication: unexpected("getApplication"),
    listAspsps: unexpected("listAspsps"),
    startAuthorization: unexpected("startAuthorization"),
    createSession: unexpected("createSession"),
    getSession: unexpected("getSession"),
    deleteSession: unexpected("deleteSession"),
    getBalances: unexpected("getBalances"),
    getTransactions: unexpected("getTransactions"),
    ...overrides,
  };
}

/** The documented `GET /sessions/{id}` fixture (eb-api-notes.md §6) with another status. */
export function sessionStatus(status: EbSessionStatus["status"]): EbSessionStatus {
  return { ...(sessionStatusFixture as unknown as EbSessionStatus), status };
}

let sequence = 0;

export function insertConnection(
  fx: LifecycleFixture,
  input: {
    validUntil: number;
    status?: StoredConnectionStatus;
    aspspName?: string;
    providerSessionId?: string;
    statusCheckedAt?: number | null;
    removedAt?: number | null;
  },
): number {
  const at = fx.clock.now;
  const result = fx.t.sqlite
    .prepare(
      `INSERT INTO bank_connections (aspsp_name, aspsp_country, aspsp_logo_url, psu_type,
         provider_session_id, status, valid_until, status_checked_at, created_at, updated_at, removed_at)
       VALUES (?, 'IT', NULL, 'personal', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.aspspName ?? BANK_NAME,
      input.providerSessionId ?? SESSION_ID,
      input.status ?? "active",
      input.validUntil,
      input.statusCheckedAt ?? null,
      at,
      at,
      input.removedAt ?? null,
    );
  return Number(result.lastInsertRowid);
}

export interface AccountInput {
  status?: AccountStatus;
  nickname?: string | null;
  product?: string | null;
  cashAccountType?: string | null;
  last4?: string | null;
  lastSyncedAt?: number | null;
  lastSyncErrorAt?: number | null;
  createdAt?: number;
  removedAt?: number | null;
}

export function insertAccount(
  fx: LifecycleFixture,
  connectionId: number,
  input: AccountInput = {},
): number {
  sequence += 1;
  const createdAt = input.createdAt ?? fx.clock.now;
  const last4 = input.last4 === undefined ? String(1000 + sequence) : input.last4;
  const result = fx.t.sqlite
    .prepare(
      `INSERT INTO accounts (connection_id, provider_account_uid, identification_hash, iban,
         masked_identifier, last4, product, details, nickname, currency, cash_account_type, status,
         last_synced_at, last_sync_error_at, created_at, updated_at, removed_at)
       VALUES (?, NULL, ?, NULL, ?, ?, ?, NULL, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      connectionId,
      `fixture-account-${sequence}`,
      last4 === null ? null : `•••• ${last4}`,
      last4,
      input.product === undefined ? "Conto corrente" : input.product,
      input.nickname ?? null,
      input.cashAccountType === undefined ? "CACC" : input.cashAccountType,
      input.status ?? "active",
      input.lastSyncedAt ?? null,
      input.lastSyncErrorAt ?? null,
      createdAt,
      createdAt,
      input.removedAt ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function insertTransactions(fx: LifecycleFixture, accountId: number, count: number): void {
  const at = fx.clock.now;
  const statement = fx.t.sqlite.prepare(
    `INSERT INTO transactions (account_id, provider_reference, fingerprint, status, booking_date,
       value_date, sort_date, amount_minor, currency, counterparty, search_text, raw_json,
       missing_count, first_seen_at, last_seen_at)
     VALUES (?, NULL, ?, 'booked', '2026-11-02', '2026-11-02', '2026-11-02', -1250, 'EUR',
       'Generic Grocery', 'generic grocery', '{}', 0, ?, ?)`,
  );
  for (let index = 0; index < count; index++) {
    statement.run(accountId, `fixture-${accountId}-${index}`, at, at);
  }
}

export function insertBalance(fx: LifecycleFixture, accountId: number): void {
  fx.t.sqlite
    .prepare(
      `INSERT INTO balances (account_id, balance_type, amount_minor, currency, reference_date, as_of, fetched_at)
       VALUES (?, 'CLBD', 152000, 'EUR', '2026-11-08', ?, ?)`,
    )
    .run(accountId, fx.clock.now, fx.clock.now);
}

export function insertSyncRun(
  fx: LifecycleFixture,
  accountId: number,
  status: SyncRunStatus,
  startedAt: number,
  errorCode: string | null = null,
  skipReason: SkipReason | null = null,
): number {
  const result = fx.t.sqlite
    .prepare(
      `INSERT INTO sync_runs (account_id, "trigger", status, skip_reason, with_psu_headers, started_at, finished_at, error_code)
       VALUES (?, 'background', ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      accountId,
      status,
      skipReason,
      startedAt,
      status === "running" ? null : startedAt + 1_000,
      errorCode,
    );
  return Number(result.lastInsertRowid);
}

export interface NotificationRow {
  event: string;
  dedupeKey: string;
  params: Record<string, string | number>;
  link: string | null;
}

export function notificationRows(fx: LifecycleFixture): NotificationRow[] {
  const rows = fx.t.sqlite
    .prepare("SELECT event, dedupe_key AS dedupeKey, params, link FROM notifications ORDER BY id")
    .all() as { event: string; dedupeKey: string; params: string; link: string | null }[];
  return rows.map((row) => ({ ...row, params: JSON.parse(row.params) }));
}

export interface AuditRow {
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

export function auditRows(fx: LifecycleFixture): AuditRow[] {
  const rows = fx.t.sqlite
    .prepare("SELECT actor, action, target, details FROM audit_log ORDER BY id")
    .all() as { actor: string; action: string; target: string | null; details: string | null }[];
  return rows.map((row) => ({
    ...row,
    details: row.details === null ? null : JSON.parse(row.details),
  }));
}

export interface JobRow {
  payload: unknown;
  status: string;
  runAfter: number;
  maxAttempts: number;
  dedupeKey: string | null;
}

export function jobRows(fx: LifecycleFixture, type: string): JobRow[] {
  const rows = fx.t.sqlite
    .prepare(
      `SELECT payload, status, run_after AS runAfter, max_attempts AS maxAttempts, dedupe_key AS dedupeKey
       FROM jobs WHERE type = ? ORDER BY id`,
    )
    .all(type) as (Omit<JobRow, "payload"> & { payload: string })[];
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}
