import {
  type AccountDetailResponse,
  type AccountPatch,
  type AccountStatus,
  type AccountSummary,
  accountDisplayName,
  addDays,
  type BalanceHistoryResponse,
  type CashFlowBucket,
  type CashFlowResponse,
  type CashflowQuery,
  type ConnectionStatus,
  type ConnectionSummary,
  type ConnectionsResponse,
  calendarDaysUntil,
  diffDays,
  effectiveConnectionStatus,
  type HomeAlert,
  type HomeSummary,
  isIncludedInTotals,
  type LocalDate,
  normalizeForSearch,
  parseDecimalToMinor,
  pickPreferredBalance,
  type RemovedAccountSummary,
  type SearchResponse,
  type SkipReason,
  type StoredConnectionStatus,
  type SyncRunItem,
  type SyncRunStatus,
  type SyncTrigger,
  sumMinor,
  type TransactionDetail,
  type TransactionItem,
  type TransactionListResponse,
  type TransactionQuery,
  type TransactionStatus,
  type TransactionTab,
  toLocalDate,
} from "@bursar/shared";
import type { AuditLog } from "../audit";
import type { BursarDb, Sqlite } from "../db";
import type { JobQueue } from "../jobs/queue";
import { syncDedupeKey } from "../jobs/types";
import { buildCashFlow, type CashFlowRow, defaultCurrency } from "./cashflow";
import { isSyncFailing, SYNC_HEALTH_STATUSES } from "./health-task";

export interface QueryDeps {
  db: BursarDb;
  sqlite: Sqlite;
  queue: JobQueue;
  timezone: string;
  now: () => number;
  locale: () => "it" | "en";
}

type SqlParam = string | number;

/** Shown when nothing in the database says which currency a flow is in (no account at all). */
const FALLBACK_CURRENCY = "EUR";
/** Accounts whose transactions count in lists, totals, the summary and the search. */
const INCLUDED_ACCOUNTS_SQL = "a.status IN ('active', 'unavailable')";
const NET_WINDOW_DAYS = 30;
const SEARCH_LIMIT = 6;
const SYNC_RUN_LIMIT = 20;
const BACKUP_FAILING_THRESHOLD = 2;

interface ConnectionRow {
  id: number;
  aspsp_name: string;
  aspsp_country: string;
  aspsp_logo_url: string | null;
  status: StoredConnectionStatus;
  valid_until: number;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: number | null;
  created_at: number;
  renewed_at: number | null;
  removed_at: number | null;
}

interface AccountRow {
  id: number;
  connection_id: number;
  iban: string | null;
  masked_identifier: string | null;
  last4: string | null;
  product: string | null;
  details: string | null;
  nickname: string | null;
  currency: string;
  cash_account_type: string | null;
  status: AccountStatus;
  last_synced_at: number | null;
  last_sync_error_code: string | null;
  last_sync_error_at: number | null;
  rate_limited_until: number | null;
  created_at: number;
  updated_at: number;
  removed_at: number | null;
}

interface AccountBrief {
  id: number;
  currency: string;
  status: AccountStatus;
}

type PreferredBalance = NonNullable<AccountSummary["balance"]>;

function all<T>(deps: QueryDeps, sql: string, ...params: SqlParam[]): T[] {
  return deps.sqlite.prepare(sql).all(...params) as T[];
}

function get<T>(deps: QueryDeps, sql: string, ...params: SqlParam[]): T | undefined {
  return deps.sqlite.prepare(sql).get(...params) as T | undefined;
}

/**
 * The locale setting costs a database read, so each public query reads it once and every row of
 * that query reuses the answer.
 */
function pinLocale(deps: QueryDeps): QueryDeps {
  const locale = deps.locale();
  return { ...deps, locale: () => locale };
}

function today(deps: QueryDeps): LocalDate {
  return toLocalDate(deps.now(), deps.timezone);
}

function displayName(
  row: {
    nickname: string | null;
    product: string | null;
    details: string | null;
    cash_account_type: string | null;
    last4: string | null;
  },
  deps: QueryDeps,
): string {
  return accountDisplayName(
    {
      nickname: row.nickname,
      product: row.product,
      details: row.details,
      cashAccountType: row.cash_account_type,
      last4: row.last4,
    },
    deps.locale(),
  );
}

// Account and connection views

/**
 * The preferred balance of each account, ranked among the balances of its latest fetch only: a
 * type the bank stopped reporting must not keep winning with an old figure.
 */
function loadPreferredBalances(deps: QueryDeps): Map<number, PreferredBalance> {
  const rows = all<{
    account_id: number;
    balance_type: string;
    amount_minor: number;
    currency: string;
    as_of: number;
    reference_date: LocalDate;
  }>(
    deps,
    `SELECT account_id, balance_type, amount_minor, currency, as_of, reference_date FROM (
       SELECT b.*, ROW_NUMBER() OVER (
         PARTITION BY b.account_id, b.balance_type
         ORDER BY b.reference_date DESC, b.as_of DESC, b.id DESC
       ) AS rn FROM balances b
        WHERE b.fetched_at = (SELECT MAX(l.fetched_at) FROM balances l WHERE l.account_id = b.account_id)
     ) WHERE rn = 1`,
  );
  const byAccount = new Map<
    number,
    {
      balanceType: string;
      amountMinor: number;
      currency: string;
      asOf: number;
      referenceDate: LocalDate;
    }[]
  >();
  for (const row of rows) {
    const list = byAccount.get(row.account_id) ?? [];
    list.push({
      balanceType: row.balance_type,
      amountMinor: row.amount_minor,
      currency: row.currency,
      asOf: row.as_of,
      referenceDate: row.reference_date,
    });
    byAccount.set(row.account_id, list);
  }
  const preferred = new Map<number, PreferredBalance>();
  for (const [accountId, candidates] of byAccount) {
    const pick = pickPreferredBalance(candidates);
    if (pick) {
      preferred.set(accountId, {
        amountMinor: pick.amountMinor,
        currency: pick.currency,
        type: pick.balanceType,
        asOf: pick.asOf,
        referenceDate: pick.referenceDate,
      });
    }
  }
  return preferred;
}

interface Window30d {
  net30d: AccountSummary["net30d"];
  daily30d: CashFlowBucket[];
}

function emptyWindow(from: LocalDate): Window30d {
  return {
    net30d: { inMinor: 0, outMinor: 0, netMinor: 0 },
    daily30d: Array.from({ length: NET_WINDOW_DAYS }, (_, index) => {
      const date = addDays(from, index);
      return {
        date,
        end: date,
        inMinor: 0,
        outMinor: 0,
        netMinor: 0,
        count: 0,
        balanceMinor: null,
      };
    }),
  };
}

/** `net30d` and `daily30d` of every account from one query grouped by account and day. */
function loadWindow30d(deps: QueryDeps): { from: LocalDate; byAccount: Map<number, Window30d> } {
  const to = today(deps);
  const from = addDays(to, -(NET_WINDOW_DAYS - 1));
  const rows = all<{
    account_id: number;
    sort_date: LocalDate;
    in_minor: number;
    out_minor: number;
    n: number;
  }>(
    deps,
    `SELECT account_id, sort_date,
            COALESCE(SUM(CASE WHEN amount_minor > 0 THEN amount_minor ELSE 0 END), 0) AS in_minor,
            COALESCE(SUM(CASE WHEN amount_minor < 0 THEN -amount_minor ELSE 0 END), 0) AS out_minor,
            COUNT(*) AS n
       FROM transactions WHERE sort_date >= ? AND sort_date <= ?
      GROUP BY account_id, sort_date`,
    from,
    to,
  );
  const byAccount = new Map<number, Window30d>();
  for (const row of rows) {
    let entry = byAccount.get(row.account_id);
    if (!entry) {
      entry = emptyWindow(from);
      byAccount.set(row.account_id, entry);
    }
    entry.net30d.inMinor += row.in_minor;
    entry.net30d.outMinor += row.out_minor;
    entry.net30d.netMinor += row.in_minor - row.out_minor;
    const day = entry.daily30d[diffDays(row.sort_date, from)];
    if (day) {
      day.inMinor = row.in_minor;
      day.outMinor = row.out_minor;
      day.netMinor = row.in_minor - row.out_minor;
      day.count = row.n;
    }
  }
  return { from, byAccount };
}

interface AccountContext {
  balances: Map<number, PreferredBalance>;
  window30d: { from: LocalDate; byAccount: Map<number, Window30d> };
  syncing: Set<string>;
}

function loadAccountContext(deps: QueryDeps): AccountContext {
  return {
    balances: loadPreferredBalances(deps),
    window30d: loadWindow30d(deps),
    syncing: deps.queue.activeKeys("sync:"),
  };
}

function toAccountSummary(row: AccountRow, ctx: AccountContext, deps: QueryDeps): AccountSummary {
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: displayName(row, deps),
    nickname: row.nickname,
    bankProduct: row.product,
    maskedIdentifier: row.masked_identifier,
    iban: row.iban,
    last4: row.last4,
    currency: row.currency,
    cashAccountType: row.cash_account_type,
    status: row.status,
    balance: ctx.balances.get(row.id) ?? null,
    ...(ctx.window30d.byAccount.get(row.id) ?? emptyWindow(ctx.window30d.from)),
    lastSyncedAt: row.last_synced_at,
    lastSyncError:
      row.last_sync_error_at === null
        ? null
        : { code: row.last_sync_error_code, at: row.last_sync_error_at },
    rateLimitedUntil: row.rate_limited_until,
    syncInProgress: ctx.syncing.has(syncDedupeKey(row.id)),
  };
}

function toConnectionBase(
  row: ConnectionRow,
  deps: QueryDeps,
): Omit<ConnectionSummary, "accounts"> {
  return {
    id: row.id,
    bankName: row.aspsp_name,
    country: row.aspsp_country,
    hasLogo: row.aspsp_logo_url !== null,
    status: effectiveConnectionStatus(row.status, row.valid_until, deps.now(), deps.timezone),
    validUntil: row.valid_until,
    createdAt: row.created_at,
    renewedAt: row.renewed_at,
    lastError:
      row.last_error_at === null
        ? null
        : { code: row.last_error_code, message: row.last_error_message, at: row.last_error_at },
  };
}

export function listConnectionsView(input: QueryDeps): ConnectionsResponse {
  const deps = pinLocale(input);
  const connectionRows = all<ConnectionRow>(deps, "SELECT * FROM bank_connections ORDER BY id");
  const accountRows = all<AccountRow>(deps, "SELECT * FROM accounts ORDER BY id");
  const ctx = loadAccountContext(deps);

  const connections: ConnectionSummary[] = connectionRows
    .filter((connection) => connection.removed_at === null)
    .map((connection) => ({
      ...toConnectionBase(connection, deps),
      accounts: accountRows
        .filter((a) => a.connection_id === connection.id && a.status !== "removed")
        .map((a) => toAccountSummary(a, ctx, deps)),
    }));

  const bankNames = new Map(connectionRows.map((c) => [c.id, c.aspsp_name]));
  const counts = new Map(
    all<{ account_id: number; total: number }>(
      deps,
      `SELECT t.account_id, COUNT(*) AS total FROM transactions t
         WHERE t.account_id IN (SELECT id FROM accounts WHERE status = 'removed')
         GROUP BY t.account_id`,
    ).map((row) => [row.account_id, row.total]),
  );
  const removedAccounts: RemovedAccountSummary[] = accountRows
    .filter((a) => a.status === "removed")
    .map((a) => ({
      id: a.id,
      name: displayName(a, deps),
      maskedIdentifier: a.masked_identifier,
      bankName: bankNames.get(a.connection_id) ?? "",
      transactionCount: counts.get(a.id) ?? 0,
      removedAt: a.removed_at ?? a.updated_at,
    }));

  return { connections, removedAccounts };
}

/** The currency of an account in any status, or null once the account is gone (purged). */
export function accountCurrency(deps: QueryDeps, accountId: number): string | null {
  return (
    get<{ currency: string }>(deps, "SELECT currency FROM accounts WHERE id = ?", accountId)
      ?.currency ?? null
  );
}

function summaryOf(deps: QueryDeps, row: AccountRow): AccountSummary {
  return toAccountSummary(row, loadAccountContext(deps), deps);
}

export function getAccountDetail(
  input: QueryDeps,
  accountId: number,
): AccountDetailResponse | null {
  const deps = pinLocale(input);
  const row = get<AccountRow>(deps, "SELECT * FROM accounts WHERE id = ?", accountId);
  if (!row) return null;
  const connection = get<ConnectionRow>(
    deps,
    "SELECT * FROM bank_connections WHERE id = ?",
    row.connection_id,
  );
  if (!connection) return null;
  const syncRuns = all<{
    id: number;
    trigger: SyncTrigger;
    status: SyncRunStatus;
    started_at: number;
    finished_at: number | null;
    inserted: number;
    updated: number;
    removed: number;
    error_code: string | null;
    skip_reason: SkipReason | null;
  }>(
    deps,
    `SELECT id, trigger, status, started_at, finished_at, inserted, updated, removed, error_code, skip_reason
       FROM sync_runs WHERE account_id = ? ORDER BY started_at DESC, id DESC LIMIT ${SYNC_RUN_LIMIT}`,
    accountId,
  ).map(
    (run): SyncRunItem => ({
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      inserted: run.inserted,
      updated: run.updated,
      removed: run.removed,
      errorCode: run.error_code,
      skipReason: run.skip_reason,
    }),
  );
  const count = get<{ total: number }>(
    deps,
    "SELECT COUNT(*) AS total FROM transactions WHERE account_id = ?",
    accountId,
  );
  return {
    account: summaryOf(deps, row),
    connection: toConnectionBase(connection, deps),
    syncRuns,
    transactionCount: count?.total ?? 0,
  };
}

/**
 * Daily end-of-day balances for the last `days` local days. The preferred balance is the balance
 * at the end of its reference date (a closing balance usually describes the previous business
 * day), so every day is derived from that anchor: later days add the booked flows after it,
 * earlier days undo the booked flows up to it. Null when the account is unknown or has no balance.
 */
export function balanceHistory(
  deps: QueryDeps,
  accountId: number,
  days: 30 | 90 | 365,
): BalanceHistoryResponse | null {
  if (accountCurrency(deps, accountId) === null) return null;
  const current = loadPreferredBalances(deps).get(accountId);
  if (!current) return null;

  const end = today(deps);
  const start = addDays(end, -(days - 1));
  const anchor = current.referenceDate;
  // LocalDate strings (YYYY-MM-DD) compare chronologically.
  // biome-ignore lint/complexity/useMathMinMax: date strings; Math.min would return NaN.
  const first = anchor < start ? anchor : start;
  // biome-ignore lint/complexity/useMathMinMax: date strings; Math.max would return NaN.
  const last = anchor > end ? anchor : end;
  const netByDate = new Map(
    all<{ sort_date: string; net: number }>(
      deps,
      `SELECT sort_date, SUM(amount_minor) AS net FROM transactions
         WHERE account_id = ? AND status = 'booked' AND sort_date > ? AND sort_date <= ?
         GROUP BY sort_date`,
      accountId,
      first,
      last,
    ).map((row) => [row.sort_date, row.net]),
  );

  const balanceAt = new Map<LocalDate, number>([[anchor, current.amountMinor]]);
  // Forward: the end of the next day is this day's end plus the next day's booked flow.
  let balance = current.amountMinor;
  for (let date = anchor; date < last; ) {
    date = addDays(date, 1);
    balance += netByDate.get(date) ?? 0;
    balanceAt.set(date, balance);
  }
  // Backward: the end of the previous day is this day's end minus this day's booked flow.
  balance = current.amountMinor;
  for (let date = anchor; date > first; date = addDays(date, -1)) {
    balance -= netByDate.get(date) ?? 0;
    balanceAt.set(addDays(date, -1), balance);
  }

  const points = Array.from({ length: days }, (_, offset) => {
    const date = addDays(start, offset);
    return { date, balanceMinor: balanceAt.get(date) ?? current.amountMinor };
  });
  return { currency: current.currency, points };
}

// Transaction filters

interface RowFilter {
  q?: string | undefined;
  accountId?: number | undefined;
  from?: LocalDate | undefined;
  to?: LocalDate | undefined;
  currency?: string | undefined;
}

interface SqlFragment {
  where: string[];
  params: SqlParam[];
}

/** True when `part` is digits grouped by `separator` as thousands: 1 to 3 digits, then groups of 3. */
function isThousandsGrouped(part: string, separator: string): boolean {
  const groups = part.split(separator);
  const [head = "", ...rest] = groups;
  return /^\d{1,3}$/u.test(head) && rest.every((group) => /^\d{3}$/u.test(group));
}

/**
 * Turns a typed amount into a canonical decimal string. `1.234,56`, `1,234.56`, `12,5` and `12`
 * are understood. When both separators appear the last one is the decimal point and the other
 * must group thousands. A single separator that occurs once is a decimal point, except a lone `.`
 * followed by exactly three digits after 1 to 3 digits, which groups thousands (`1.234` is 1234).
 * A separator that occurs several times must group thousands. Returns null for anything else.
 */
export function canonicalizeAmount(
  input: string,
): { sign: "+" | "-" | null; decimal: string } | null {
  const match = /^([+-])?\s*(\d[\d.,\s]*)$/u.exec(input.trim());
  if (!match) return null;
  const sign = match[1] === "-" || match[1] === "+" ? match[1] : null;
  const body = (match[2] ?? "").replace(/\s+/gu, "");
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");

  let integer = body;
  let fraction = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    const decimalChar = body.charAt(decimalAt);
    const thousandsChar = decimalChar === "." ? "," : ".";
    integer = body.slice(0, decimalAt);
    fraction = body.slice(decimalAt + 1);
    if (!isThousandsGrouped(integer, thousandsChar)) return null;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastComma >= 0 ? "," : ".";
    const at = body.lastIndexOf(separator);
    const occurrences = body.split(separator).length - 1;
    if (occurrences > 1) {
      if (!isThousandsGrouped(body, separator)) return null;
    } else if (
      separator === "." &&
      /^\d{3}$/u.test(body.slice(at + 1)) &&
      /^[1-9]\d{0,2}$/u.test(body.slice(0, at))
    ) {
      // "1.234" reads as 1234: a thousands separator, not a decimal point.
    } else {
      integer = body.slice(0, at);
      fraction = body.slice(at + 1);
    }
  }
  integer = integer.replace(/[.,]/gu, "");
  if (!/^\d+$/u.test(integer) || !/^\d*$/u.test(fraction)) return null;
  integer = integer.replace(/^0+(?=\d)/u, "");
  return { sign, decimal: fraction === "" ? integer : `${integer}.${fraction}` };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

function distinctCurrencies(deps: QueryDeps): string[] {
  return all<{ currency: string }>(deps, "SELECT DISTINCT currency FROM accounts").map(
    (row) => row.currency,
  );
}

/**
 * Matches the normalised text in `search_text`, or an amount equal to the typed number in any
 * currency of the database (using that currency's minor digits). An unsigned number matches
 * inflows and outflows alike; a signed one matches only that direction.
 */
function searchCondition(deps: QueryDeps, q: string): { sql: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const text = normalizeForSearch(q);
  if (text !== "") {
    clauses.push("t.search_text LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(text)}%`);
  }
  const amount = canonicalizeAmount(q);
  if (amount) {
    for (const currency of distinctCurrencies(deps)) {
      let minor: number;
      try {
        minor = parseDecimalToMinor(amount.decimal, currency);
      } catch {
        continue;
      }
      if (amount.sign === null) {
        clauses.push("(t.currency = ? AND ABS(t.amount_minor) = ?)");
        params.push(currency, minor);
      } else {
        clauses.push("(t.currency = ? AND t.amount_minor = ?)");
        params.push(currency, amount.sign === "-" ? -minor : minor);
      }
    }
  }
  if (clauses.length === 0) return { sql: "0", params: [] };
  return { sql: `(${clauses.join(" OR ")})`, params };
}

/**
 * The WHERE conditions shared by every transaction query (alias `t` for transactions and `a` for
 * accounts). Without an explicit account only accounts counted in the totals are searched; an
 * explicit account may be any account that still exists.
 */
function transactionFilter(
  deps: QueryDeps,
  filter: RowFilter,
  options: { currency: boolean },
): SqlFragment {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (filter.accountId !== undefined) {
    where.push("t.account_id = ?");
    params.push(filter.accountId);
  } else {
    where.push(INCLUDED_ACCOUNTS_SQL);
  }
  if (filter.from !== undefined) {
    where.push("t.sort_date >= ?");
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    where.push("t.sort_date <= ?");
    params.push(filter.to);
  }
  if (options.currency && filter.currency !== undefined) {
    where.push("t.currency = ?");
    params.push(filter.currency);
  }
  if (filter.q !== undefined) {
    const search = searchCondition(deps, filter.q);
    where.push(search.sql);
    params.push(...search.params);
  }
  return { where, params };
}

function tabCondition(tab: TransactionTab): string | null {
  switch (tab) {
    case "in":
      return "t.amount_minor > 0";
    case "out":
      return "t.amount_minor < 0";
    case "pending":
      return "t.status = 'pending'";
    default:
      return null;
  }
}

const FROM_TRANSACTIONS = "FROM transactions t JOIN accounts a ON a.id = t.account_id";
const ITEM_COLUMNS = `t.id, t.account_id, t.status, t.sort_date, t.booking_date, t.value_date,
  t.amount_minor, t.currency, t.counterparty, t.remittance,
  a.nickname, a.product, a.details, a.cash_account_type, a.last4`;

const registeredFold = new WeakSet<Sqlite>();

/**
 * better-sqlite3 has no custom collations, so ordering by counterparty goes through a scalar
 * function that folds case and accents, which also matches the panel's search normalisation.
 */
function ensureFoldFunction(sqlite: Sqlite): void {
  if (registeredFold.has(sqlite)) return;
  sqlite.function("bursar_fold", { deterministic: true }, (value: unknown) =>
    typeof value === "string" ? normalizeForSearch(value) : null,
  );
  registeredFold.add(sqlite);
}

function orderClause(sort: TransactionQuery["sort"], order: TransactionQuery["order"]): string {
  const direction = order === "asc" ? "ASC" : "DESC";
  switch (sort) {
    case "amount":
      return `t.amount_minor ${direction}, t.sort_date DESC, t.id DESC`;
    case "counterparty":
      return `t.counterparty IS NULL, bursar_fold(t.counterparty) ${direction}, t.sort_date DESC, t.id DESC`;
    default:
      return `t.sort_date ${direction}, t.id ${direction}`;
  }
}

/** The SQL and parameters of one page of the transaction list (exported for the query-plan test). */
export function buildTransactionListSql(
  deps: QueryDeps,
  query: TransactionQuery,
): { sql: string; params: SqlParam[] } {
  ensureFoldFunction(deps.sqlite);
  const filter = transactionFilter(deps, query, { currency: true });
  const tab = tabCondition(query.tab);
  if (tab) filter.where.push(tab);
  return {
    sql: `SELECT ${ITEM_COLUMNS} ${FROM_TRANSACTIONS}
            WHERE ${filter.where.join(" AND ")}
            ORDER BY ${orderClause(query.sort, query.order)}
            LIMIT ? OFFSET ?`,
    params: [...filter.params, query.pageSize, (query.page - 1) * query.pageSize],
  };
}

interface ItemRow {
  id: number;
  account_id: number;
  status: TransactionStatus;
  sort_date: LocalDate;
  booking_date: LocalDate | null;
  value_date: LocalDate | null;
  amount_minor: number;
  currency: string;
  counterparty: string | null;
  remittance: string | null;
  nickname: string | null;
  product: string | null;
  details: string | null;
  cash_account_type: string | null;
  last4: string | null;
}

function toTransactionItem(row: ItemRow, deps: QueryDeps): TransactionItem {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: displayName(row, deps),
    status: row.status,
    date: row.sort_date,
    bookingDate: row.booking_date,
    valueDate: row.value_date,
    amountMinor: row.amount_minor,
    currency: row.currency,
    counterparty: row.counterparty,
    description: row.remittance,
  };
}

function facetCounts(deps: QueryDeps, query: TransactionQuery): Record<TransactionTab, number> {
  const filter = transactionFilter(deps, query, { currency: true });
  const row = get<{
    all_count: number;
    in_count: number;
    out_count: number;
    pending_count: number;
  }>(
    deps,
    `SELECT COUNT(*) AS all_count,
            COALESCE(SUM(t.amount_minor > 0), 0) AS in_count,
            COALESCE(SUM(t.amount_minor < 0), 0) AS out_count,
            COALESCE(SUM(t.status = 'pending'), 0) AS pending_count
       ${FROM_TRANSACTIONS} WHERE ${filter.where.join(" AND ")}`,
    ...filter.params,
  );
  return {
    all: row?.all_count ?? 0,
    in: row?.in_count ?? 0,
    out: row?.out_count ?? 0,
    pending: row?.pending_count ?? 0,
  };
}

function loadAccountBriefs(deps: QueryDeps): AccountBrief[] {
  return all<AccountBrief>(deps, "SELECT id, currency, status FROM accounts ORDER BY id");
}

/**
 * The cash flow of everything the list filters match except the tab, in one currency (no FX):
 * the requested one, else the default currency when it appears, else the first that does.
 */
function listAggregate(deps: QueryDeps, query: TransactionQuery): CashFlowResponse {
  const unconstrained = transactionFilter(deps, query, { currency: false });
  const currencies = all<{ currency: string }>(
    deps,
    `SELECT DISTINCT t.currency ${FROM_TRANSACTIONS} WHERE ${unconstrained.where.join(" AND ")} ORDER BY t.currency`,
    ...unconstrained.params,
  ).map((row) => row.currency);
  const preferred = defaultCurrency(loadAccountBriefs(deps));
  const currency =
    query.currency ??
    (preferred !== null && currencies.includes(preferred) ? preferred : undefined) ??
    currencies[0] ??
    preferred ??
    FALLBACK_CURRENCY;

  const filter = transactionFilter(deps, { ...query, currency }, { currency: true });
  const rows = all<CashFlowRow>(
    deps,
    `SELECT t.sort_date AS date, t.amount_minor AS amountMinor, t.status AS status
       ${FROM_TRANSACTIONS} WHERE ${filter.where.join(" AND ")}`,
    ...filter.params,
  );

  const day = today(deps);
  if (rows.length === 0) {
    return buildCashFlow([], {
      from: day,
      to: day,
      currency,
      currencies,
      currentBalanceMinor: null,
    });
  }
  let first = rows[0]?.date ?? day;
  let last = first;
  for (const row of rows) {
    if (row.date < first) first = row.date;
    if (row.date > last) last = row.date;
  }
  return buildCashFlow(rows, {
    from: query.from ?? first,
    to: query.to ?? last,
    currency,
    currencies,
    currentBalanceMinor: null,
  });
}

export function listTransactions(
  input: QueryDeps,
  query: TransactionQuery,
): TransactionListResponse {
  const deps = pinLocale(input);
  const facets = facetCounts(deps, query);
  const { sql, params } = buildTransactionListSql(deps, query);
  const items = all<ItemRow>(deps, sql, ...params).map((row) => toTransactionItem(row, deps));
  return {
    items,
    total: facets[query.tab],
    page: query.page,
    pageSize: query.pageSize,
    facets,
    aggregate: listAggregate(deps, query),
  };
}

function parseBankCode(value: string | null): TransactionDetail["bankCode"] {
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

/** The bank's own remittance lines, kept as delivered; falls back to the joined text. */
function remittanceLines(rawJson: string, remittance: string | null): string[] {
  try {
    const raw: unknown = JSON.parse(rawJson);
    if (typeof raw === "object" && raw !== null) {
      const lines = (raw as Record<string, unknown>).remittance_information;
      if (Array.isArray(lines)) {
        const kept = lines
          .filter((line): line is string => typeof line === "string")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        if (kept.length > 0) return kept;
      }
    }
  } catch {
    // Unreadable raw payload: use the stored text below.
  }
  return remittance ? [remittance] : [];
}

export function getTransaction(input: QueryDeps, id: number): TransactionDetail | null {
  const deps = pinLocale(input);
  const row = get<
    ItemRow & {
      transaction_date: LocalDate | null;
      provider_reference: string | null;
      counterparty_account: string | null;
      bank_code: string | null;
      merchant_category_code: string | null;
      balance_after_minor: number | null;
      raw_json: string;
      first_seen_at: number;
      last_seen_at: number;
      bank_name: string;
    }
  >(
    deps,
    `SELECT t.id, t.account_id, t.status, t.sort_date, t.booking_date, t.value_date, t.transaction_date,
            t.amount_minor, t.currency, t.counterparty, t.remittance, t.provider_reference,
            t.counterparty_account, t.bank_code, t.merchant_category_code, t.balance_after_minor,
            t.raw_json, t.first_seen_at, t.last_seen_at,
            a.nickname, a.product, a.details, a.cash_account_type, a.last4,
            c.aspsp_name AS bank_name
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN bank_connections c ON c.id = a.connection_id
      WHERE t.id = ?`,
    id,
  );
  if (!row) return null;
  return {
    ...toTransactionItem(row, deps),
    transactionDate: row.transaction_date,
    providerReference: row.provider_reference,
    counterpartyAccount: row.counterparty_account,
    remittanceLines: remittanceLines(row.raw_json, row.remittance),
    bankCode: parseBankCode(row.bank_code),
    merchantCategoryCode: row.merchant_category_code,
    balanceAfter:
      row.balance_after_minor === null
        ? null
        : { amountMinor: row.balance_after_minor, currency: row.currency },
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    bankName: row.bank_name,
  };
}

// Cash flow

/**
 * The strip for a scope (one account, or every account counted in the totals) and one currency.
 * The period defaults to the 30 local days ending today. The running balance at the end of the
 * period is, per account, its preferred balance (the end of its reference date) plus the booked
 * flows between that date and the period end (minus them when the period ends first), so it stays
 * correct for a past period and for a closing balance of a previous day. It is null when any
 * account of the currency has no balance. With `nullWhenEmpty` a scope without any transaction (or
 * without accounts) answers null so the route can reply 204.
 */
function computeCashflow(
  deps: QueryDeps,
  query: CashflowQuery,
  options: { nullWhenEmpty: boolean },
): CashFlowResponse | null {
  const briefs = loadAccountBriefs(deps);
  const scope =
    query.accountId !== undefined
      ? briefs.filter((a) => a.id === query.accountId)
      : briefs.filter((a) => isIncludedInTotals(a.status));
  if (scope.length === 0) return null;

  const currencies = [...new Set(scope.map((a) => a.currency))].sort();
  const currency =
    query.currency ??
    (query.accountId !== undefined ? scope[0]?.currency : defaultCurrency(scope)) ??
    currencies[0] ??
    FALLBACK_CURRENCY;

  const day = today(deps);
  const to = query.to ?? (query.from !== undefined && query.from > day ? query.from : day);
  const from = query.from ?? addDays(to, -(NET_WINDOW_DAYS - 1));

  const scopeFilter = transactionFilter(
    deps,
    { accountId: query.accountId, currency },
    { currency: true },
  );
  if (options.nullWhenEmpty) {
    const any = get(
      deps,
      `SELECT 1 AS found ${FROM_TRANSACTIONS} WHERE ${scopeFilter.where.join(" AND ")} LIMIT 1`,
      ...scopeFilter.params,
    );
    if (any === undefined) return null;
  }

  const periodFilter = transactionFilter(
    deps,
    { accountId: query.accountId, currency, from, to },
    { currency: true },
  );
  const rows = all<CashFlowRow>(
    deps,
    `SELECT t.sort_date AS date, t.amount_minor AS amountMinor, t.status AS status
       ${FROM_TRANSACTIONS} WHERE ${periodFilter.where.join(" AND ")}`,
    ...periodFilter.params,
  );

  let currentBalanceMinor: number | null = null;
  const balances = loadPreferredBalances(deps);
  const sameCurrency = scope.filter((a) => a.currency === currency);
  const known = sameCurrency.flatMap((a) => {
    const balance = balances.get(a.id);
    return balance && balance.currency === currency ? [{ accountId: a.id, balance }] : [];
  });
  if (sameCurrency.length > 0 && known.length === sameCurrency.length) {
    currentBalanceMinor = sumMinor(
      known.map(({ accountId, balance }) => {
        // Booked flows after the reference date minus those after the period end: the move from
        // the end of the reference date to the end of `to` (negative when `to` comes first).
        const moved = get<{ total: number }>(
          deps,
          `SELECT COALESCE(SUM(CASE WHEN t.sort_date > ? THEN t.amount_minor ELSE 0 END), 0)
                - COALESCE(SUM(CASE WHEN t.sort_date > ? THEN t.amount_minor ELSE 0 END), 0) AS total
             ${FROM_TRANSACTIONS} WHERE ${scopeFilter.where.join(" AND ")} AND t.status = 'booked'
              AND t.account_id = ?`,
          balance.referenceDate,
          to,
          ...scopeFilter.params,
          accountId,
        );
        return balance.amountMinor + (moved?.total ?? 0);
      }),
    );
  }

  return buildCashFlow(rows, { from, to, currency, currencies, currentBalanceMinor });
}

export function cashflow(deps: QueryDeps, query: CashflowQuery): CashFlowResponse | null {
  return computeCashflow(deps, query, { nullWhenEmpty: true });
}

// Home summary

function buildAlerts(
  deps: QueryDeps,
  backup: { target: "local" | "s3"; consecutiveFailures: number },
  connections: ConnectionRow[],
  accounts: AccountRow[],
): HomeAlert[] {
  const now = deps.now();
  const broken: HomeAlert[] = [];
  const expiring: { days: number; alert: HomeAlert }[] = [];
  const usable = new Set<number>();
  const bankNames = new Map<number, string>();

  for (const connection of connections) {
    bankNames.set(connection.id, connection.aspsp_name);
    const status: ConnectionStatus = effectiveConnectionStatus(
      connection.status,
      connection.valid_until,
      now,
      deps.timezone,
    );
    const base = { connectionId: connection.id, bankName: connection.aspsp_name };
    if (status === "active" || status === "expiring") usable.add(connection.id);
    if (status === "revoked" || status === "error") {
      broken.push({ kind: "connection_error", ...base });
    } else if (status === "expired") {
      broken.push({ kind: "consent_expired", ...base });
    } else if (status === "expiring") {
      const days = Math.max(0, calendarDaysUntil(connection.valid_until, now, deps.timezone));
      expiring.push({ days, alert: { kind: "consent_expiring", ...base, days } });
    }
  }
  expiring.sort((a, b) => a.days - b.days);

  const syncFailing: HomeAlert[] = [];
  const rateLimited: HomeAlert[] = [];
  for (const account of accounts) {
    if (!SYNC_HEALTH_STATUSES.includes(account.status) || !usable.has(account.connection_id)) {
      continue;
    }
    const name = displayName(account, deps);
    const failing = isSyncFailing(
      {
        lastSyncedAt: account.last_synced_at,
        lastSyncErrorAt: account.last_sync_error_at,
        createdAt: account.created_at,
      },
      now,
    );
    if (failing) {
      syncFailing.push({
        kind: "sync_failing",
        accountId: account.id,
        accountName: name,
        since: account.last_synced_at,
      });
    }
    if (
      account.status === "active" &&
      account.rate_limited_until !== null &&
      account.rate_limited_until > now
    ) {
      rateLimited.push({
        kind: "rate_limited",
        accountId: account.id,
        accountName: name,
        until: account.rate_limited_until,
      });
    }
  }

  const alerts: HomeAlert[] = [
    ...broken,
    ...expiring.map((entry) => entry.alert),
    ...syncFailing,
    ...rateLimited,
  ];
  if (backup.consecutiveFailures >= BACKUP_FAILING_THRESHOLD) {
    alerts.push({ kind: "backup_failing", failures: backup.consecutiveFailures });
  }
  if (backup.target === "local") alerts.push({ kind: "backup_local_only" });
  return alerts;
}

export function homeSummary(
  input: QueryDeps,
  backup: { target: "local" | "s3"; consecutiveFailures: number },
): HomeSummary {
  const deps = pinLocale(input);
  const connections = all<ConnectionRow>(
    deps,
    "SELECT * FROM bank_connections WHERE removed_at IS NULL ORDER BY id",
  );
  const connectionIds = new Set(connections.map((c) => c.id));
  const accounts = all<AccountRow>(
    deps,
    "SELECT * FROM accounts WHERE status != 'removed' ORDER BY id",
  ).filter((a) => connectionIds.has(a.connection_id));
  const included = accounts.filter((a) => isIncludedInTotals(a.status));
  const ctx = loadAccountContext(deps);

  const perCurrency = new Map<string, { amounts: number[] }>();
  for (const account of included) {
    const balance = ctx.balances.get(account.id);
    if (!balance) continue;
    const entry = perCurrency.get(balance.currency) ?? { amounts: [] };
    entry.amounts.push(balance.amountMinor);
    perCurrency.set(balance.currency, entry);
  }
  const balances = [...perCurrency]
    .map(([currency, entry]) => ({
      currency,
      amountMinor: sumMinor(entry.amounts),
      accountCount: entry.amounts.length,
    }))
    .sort((a, b) => b.accountCount - a.accountCount || a.currency.localeCompare(b.currency, "en"));

  return {
    generatedAt: deps.now(),
    balances,
    cashflow30d: computeCashflow(deps, {}, { nullWhenEmpty: false }),
    accounts: included.map((a) => toAccountSummary(a, ctx, deps)),
    alerts: buildAlerts(deps, backup, connections, accounts),
    hasConnections: connections.length > 0,
  };
}

// Search

export function searchAll(input: QueryDeps, q: string): SearchResponse {
  const deps = pinLocale(input);
  const needle = normalizeForSearch(q);
  const compact = needle.replaceAll(" ", "");
  const accounts = all<AccountRow & { bank_name: string }>(
    deps,
    `SELECT a.*, c.aspsp_name AS bank_name FROM accounts a
       JOIN bank_connections c ON c.id = a.connection_id
      WHERE a.status != 'removed' ORDER BY a.id`,
  )
    .filter((a) => {
      const haystack = normalizeForSearch(
        [displayName(a, deps), a.bank_name, a.last4 ?? "", a.iban ?? ""].join(" "),
      );
      return haystack.includes(needle) || (a.iban?.toLowerCase().includes(compact) ?? false);
    })
    .slice(0, SEARCH_LIMIT)
    .map((a) => ({ id: a.id, name: displayName(a, deps), bankName: a.bank_name, last4: a.last4 }));

  const filter = transactionFilter(deps, { q }, { currency: false });
  const transactions = all<ItemRow>(
    deps,
    `SELECT ${ITEM_COLUMNS} ${FROM_TRANSACTIONS}
      WHERE ${filter.where.join(" AND ")}
      ORDER BY t.sort_date DESC, t.id DESC LIMIT ${SEARCH_LIMIT}`,
    ...filter.params,
  ).map((row) => ({
    id: row.id,
    counterparty: (row.counterparty ?? row.remittance ?? "").slice(0, 120),
    date: row.sort_date,
    amountMinor: row.amount_minor,
    currency: row.currency,
    accountName: displayName(row, deps),
  }));

  return { accounts, transactions };
}

// Account update

/**
 * Renames, disables or enables an account. A removed account cannot change. Enabling an account
 * the bank reported as unavailable sets it back to active so the next sync tries it again. Audit
 * rows name the action and the account but never carry the nickname text.
 */
export function updateAccount(
  input: QueryDeps & { audit: AuditLog },
  accountId: number,
  patch: AccountPatch,
): AccountSummary | null | "not_allowed" {
  const deps = { ...pinLocale(input), audit: input.audit };
  const row = get<AccountRow>(deps, "SELECT * FROM accounts WHERE id = ?", accountId);
  if (!row) return null;
  if (row.status === "removed") return "not_allowed";

  const assignments: string[] = [];
  const params: (string | number | null)[] = [];
  const audits: Parameters<AuditLog["record"]>[0][] = [];
  const target = `account:${accountId}`;
  if (patch.nickname !== undefined && patch.nickname !== row.nickname) {
    assignments.push("nickname = ?");
    params.push(patch.nickname);
    audits.push({
      actor: "user",
      action: "account.rename",
      target,
      details: { cleared: patch.nickname === null },
    });
  }
  if (patch.status !== undefined && patch.status !== row.status) {
    assignments.push("status = ?");
    params.push(patch.status);
    audits.push({
      actor: "user",
      action: patch.status === "disabled" ? "account.disable" : "account.enable",
      target,
    });
  }

  if (assignments.length > 0) {
    deps.sqlite.transaction(() => {
      deps.sqlite
        .prepare(`UPDATE accounts SET ${assignments.join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...params, deps.now(), accountId);
      for (const entry of audits) deps.audit.record(entry);
    })();
  }

  const updated = get<AccountRow>(deps, "SELECT * FROM accounts WHERE id = ?", accountId);
  return updated ? summaryOf(deps, updated) : null;
}
