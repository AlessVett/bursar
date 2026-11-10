import {
  addDays,
  effectiveConnectionStatus,
  type LocalDate,
  MoneyParseError,
  type SkipReason,
  type SyncTrigger,
  toLocalDate,
} from "@bursar/shared";
import type { Logger } from "pino";
import type { EnableBankingApi, PsuHeaders, TransactionsQuery } from "../eb/client";
import { EnableBankingError } from "../eb/errors";
import type { EbBalance, EbTransaction } from "../eb/schemas";
import type { EventBus } from "../events/bus";
import { isPublicIp } from "../http/client-ip";
import { backoffMs, type JobQueue } from "../jobs/queue";
import {
  parsePayload,
  SYNC_ACCOUNT_JOB,
  type SyncAccountPayload,
  syncAccountPayloadSchema,
  syncDedupeKey,
} from "../jobs/types";
import { type JobHandler, PermanentJobError } from "../jobs/worker";
import type { NotificationService } from "../notifications/service";
import type { SettingsStore } from "../settings/store";
import { type ConnectionStatusDeps, markConnectionEnded } from "./connection-status";
import {
  assignFingerprints,
  type NormalizedTransaction,
  normalizeBalance,
  normalizeTransaction,
} from "./normalize";
import { applyReconciliation, planReconciliation } from "./reconcile";
import type { AccountRow, ConnectionRow, FinanceRepository, NewSyncRun } from "./repository";

export const MAX_TRANSACTION_PAGES = 500;
export const RATE_LIMIT_PAUSE_MS = 6 * 3_600_000;
export const SYNC_LOOKBACK_DAYS = 7;
/**
 * An incremental fetch reaches back to the oldest stored pending entry (so a pending row the bank
 * stopped listing is counted missing and removed, spec §6.3), but never further than this.
 */
export const PENDING_LOOKBACK_DAYS = 90;
/** One run plus two retries, after 30 s and 2 min (the queue's `backoffMs`). */
export const SYNC_MAX_ATTEMPTS = 3;
/** Error codes raised by Bursar itself; they share `errorCode` with Enable Banking codes. */
export const PAGINATION_LOOP = "PAGINATION_LOOP";
export const INTERNAL_ERROR = "INTERNAL_ERROR";
/** Provider data Bursar cannot read (a malformed amount that escaped the per-item checks). */
export const INVALID_PROVIDER_DATA = "INVALID_PROVIDER_DATA";

const PSU_HEADER_ERRORS: ReadonlySet<string> = new Set([
  "PSU_HEADER_NOT_PROVIDED",
  "PSU_HEADER_INVALID",
]);
const MAX_ERROR_MESSAGE_LENGTH = 500;

export interface SyncDeps {
  repo: FinanceRepository;
  api: EnableBankingApi;
  bus: EventBus;
  notifications: NotificationService;
  settings: SettingsStore;
  timezone: string;
  now: () => number;
  logger: Logger;
}

export interface SyncOutcome {
  status: "succeeded" | "failed" | "skipped";
  fetched: number;
  inserted: number;
  updated: number;
  removed: number;
  errorCode: string | null;
  skipReason: SkipReason | null;
  retryAt: number | null;
}

type AccountPatch = Parameters<FinanceRepository["updateAccount"]>[1];

interface ActiveRun {
  id: number;
  account: AccountRow;
  trigger: SyncTrigger;
  /** Headers used by the current fetch; cleared by the PSU fallback. */
  psu: PsuHeaders | undefined;
  /**
   * The provider session and account uid the requests use. A renewal can replace both while the
   * bank answers; an error about the old ones must not change the renewed connection or account.
   */
  sessionId: string;
  uid: string;
}

interface TransactionWindow {
  strategy: "default" | "longest";
  dateFrom: LocalDate | null;
}

interface FetchedData {
  balances: EbBalance[];
  transactions: EbTransaction[];
  /** Start of the requested period; null when the longest history was fetched. */
  windowStart: LocalDate | null;
  /** Provider items the client already dropped (schema mismatch). */
  skipped: number;
}

type Preflight =
  | { kind: "skip"; reason: SkipReason; retryAt: number | null }
  | { kind: "run"; uid: string; sessionId: string };

/** A run stopped by a guard of Bursar's own (not by an Enable Banking error). */
class SyncAbortError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SyncAbortError";
  }
}

function emptyOutcome(
  status: SyncOutcome["status"],
  patch: Partial<Omit<SyncOutcome, "status">> = {},
): SyncOutcome {
  return {
    status,
    fetched: 0,
    inserted: 0,
    updated: 0,
    removed: 0,
    errorCode: null,
    skipReason: null,
    retryAt: null,
    ...patch,
  };
}

function newRun(
  accountId: number,
  trigger: SyncTrigger,
  startedAt: number,
  overrides: Pick<NewSyncRun, "status"> & Partial<NewSyncRun>,
): NewSyncRun {
  return {
    accountId,
    trigger,
    skipReason: null,
    withPsuHeaders: false,
    startedAt,
    finishedAt: null,
    ...overrides,
  };
}

function statusDeps(deps: SyncDeps): ConnectionStatusDeps {
  return {
    repo: deps.repo,
    notifications: deps.notifications,
    bus: deps.bus,
    now: deps.now,
    timezone: deps.timezone,
  };
}

function preflight(
  deps: SyncDeps,
  account: AccountRow,
  connection: ConnectionRow | null,
  now: number,
): Preflight {
  if (account.status !== "active") {
    return { kind: "skip", reason: "account_inactive", retryAt: null };
  }
  if (!connection || connection.removedAt !== null) {
    return { kind: "skip", reason: "connection_inactive", retryAt: null };
  }
  const status = effectiveConnectionStatus(
    connection.status,
    connection.validUntil,
    now,
    deps.timezone,
  );
  if (status === "expired" || status === "revoked" || status === "error") {
    return { kind: "skip", reason: "connection_inactive", retryAt: null };
  }
  if (account.providerAccountUid === null) {
    return { kind: "skip", reason: "no_provider_uid", retryAt: null };
  }
  if (account.rateLimitedUntil !== null && account.rateLimitedUntil > now) {
    return { kind: "skip", reason: "rate_limited", retryAt: account.rateLimitedUntil };
  }
  return {
    kind: "run",
    uid: account.providerAccountUid,
    sessionId: connection.providerSessionId,
  };
}

/** PSU headers are forwarded only for a manual sync from a public client address. */
function forwardedPsu(payload: SyncAccountPayload): PsuHeaders | undefined {
  if (payload.trigger !== "manual" || !payload.psu) return undefined;
  return isPublicIp(payload.psu.ipAddress) ? payload.psu : undefined;
}

function isPsuHeaderError(error: unknown): error is EnableBankingError {
  return (
    error instanceof EnableBankingError && error.code !== null && PSU_HEADER_ERRORS.has(error.code)
  );
}

function publishFinished(
  deps: SyncDeps,
  account: AccountRow,
  trigger: SyncTrigger,
  outcome: SyncOutcome,
): void {
  deps.bus.publish({
    type: "sync.finished",
    accountId: account.id,
    connectionId: account.connectionId,
    trigger,
    status: outcome.status,
    inserted: outcome.inserted,
    updated: outcome.updated,
    removed: outcome.removed,
    errorCode: outcome.errorCode,
    skipReason: outcome.skipReason,
    retryAt: outcome.retryAt,
  });
}

function recordSkip(
  deps: SyncDeps,
  account: AccountRow,
  trigger: SyncTrigger,
  reason: SkipReason,
  retryAt: number | null,
): SyncOutcome {
  const now = deps.now();
  deps.repo.startSyncRun(
    newRun(account.id, trigger, now, { status: "skipped", skipReason: reason, finishedAt: now }),
  );
  const outcome = emptyOutcome("skipped", { skipReason: reason, retryAt });
  publishFinished(deps, account, trigger, outcome);
  deps.logger.debug({ accountId: account.id, trigger, skipReason: reason }, "Account sync skipped");
  return outcome;
}

function lastSyncPatch(outcome: SyncOutcome, now: number): AccountPatch {
  if (outcome.status === "succeeded") {
    return { lastSyncedAt: now, lastSyncErrorCode: null, lastSyncErrorAt: null };
  }
  if (outcome.errorCode !== null) {
    return { lastSyncErrorCode: outcome.errorCode, lastSyncErrorAt: now };
  }
  return {};
}

/**
 * True while the account still exists and is not removed. A disconnect or a purge can land while
 * a sync waits on the bank (`cancelQueued` only drops queued jobs); every write after the network
 * calls checks this first. The check and the writes that follow run synchronously, with no
 * `await` in between, so no request handler can interleave.
 */
function isLiveAccount(deps: SyncDeps, accountId: number): boolean {
  const current = deps.repo.getAccount(accountId);
  return current !== null && current.status !== "removed";
}

function finishRun(
  deps: SyncDeps,
  run: ActiveRun,
  outcome: SyncOutcome,
  extra: { errorMessage?: string; accountPatch?: AccountPatch } = {},
): SyncOutcome {
  const now = deps.now();
  const live = isLiveAccount(deps, run.account.id);
  // After a purge the run row is gone (the repository's finishSyncRun throws for a missing run).
  if (deps.repo.getAccount(run.account.id) !== null) {
    deps.repo.finishSyncRun(run.id, {
      status: outcome.status,
      skipReason: outcome.skipReason,
      withPsuHeaders: run.psu !== undefined,
      finishedAt: now,
      fetched: outcome.fetched,
      inserted: outcome.inserted,
      updated: outcome.updated,
      removed: outcome.removed,
      errorCode: outcome.errorCode,
      errorMessage: extra.errorMessage ?? null,
    });
  }
  // A removed or purged account is never patched: a late `unavailable` or a sync timestamp would
  // bring it back to life in the panel.
  if (live) {
    deps.repo.updateAccount(run.account.id, {
      ...lastSyncPatch(outcome, now),
      ...extra.accountPatch,
      updatedAt: now,
    });
  }
  publishFinished(deps, run.account, run.trigger, outcome);
  deps.logger.info(
    {
      accountId: run.account.id,
      trigger: run.trigger,
      status: outcome.status,
      fetched: outcome.fetched,
      inserted: outcome.inserted,
      updated: outcome.updated,
      removed: outcome.removed,
      errorCode: outcome.errorCode,
      skipReason: outcome.skipReason,
    },
    "Account sync finished",
  );
  return outcome;
}

/** The oldest stored pending entry not older than `floor`, or null. */
function oldestPendingSince(
  repo: FinanceRepository,
  accountId: number,
  floor: LocalDate,
): LocalDate | null {
  let oldest: LocalDate | null = null;
  for (const row of repo.transactionsSince(accountId, floor)) {
    if (row.status === "pending" && (oldest === null || row.sortDate < oldest)) {
      oldest = row.sortDate;
    }
  }
  return oldest;
}

/**
 * The incremental window starts at `lastBooked − 7` or at the oldest stored pending entry
 * (bounded to `PENDING_LOOKBACK_DAYS`), whichever is earlier: a card hold older than the booked
 * window must be inside the window, or its absence is never counted and it is never removed.
 *
 * A booked entry dated in the future (a card statement line dated by settlement) clamps the
 * anchor to today, not the result: the seven-day look-back still applies, so an entry the bank
 * lists late with an earlier booking date stays inside the window, and the start is always at
 * least a week before today (Enable Banking reads `date_from` as a UTC date).
 */
function transactionWindow(
  repo: FinanceRepository,
  accountId: number,
  trigger: SyncTrigger,
  today: LocalDate,
): TransactionWindow {
  const lastBooked = trigger === "initial" ? null : repo.lastBookedDate(accountId);
  if (lastBooked === null) return { strategy: "longest", dateFrom: null };
  // LocalDate strings (YYYY-MM-DD) compare chronologically.
  const anchor = lastBooked > today ? today : lastBooked;
  const fromBooked = addDays(anchor, -SYNC_LOOKBACK_DAYS);
  const oldestPending = oldestPendingSince(repo, accountId, addDays(today, -PENDING_LOOKBACK_DAYS));
  const from = oldestPending !== null && oldestPending < fromBooked ? oldestPending : fromBooked;
  return { strategy: "default", dateFrom: from };
}

async function fetchTransactionPages(
  deps: SyncDeps,
  run: ActiveRun,
  uid: string,
  window: TransactionWindow,
): Promise<{ transactions: EbTransaction[]; skipped: number }> {
  const base: TransactionsQuery =
    window.dateFrom === null
      ? { strategy: window.strategy }
      : { strategy: window.strategy, dateFrom: window.dateFrom };
  const transactions: EbTransaction[] = [];
  let skipped = 0;
  const seenKeys = new Set<string>();
  let continuationKey: string | undefined;
  for (let page = 1; page <= MAX_TRANSACTION_PAGES; page += 1) {
    const query = continuationKey === undefined ? base : { ...base, continuationKey };
    const result = await deps.api.getTransactions(uid, query, run.psu);
    transactions.push(...result.transactions);
    skipped += result.skipped ?? 0;
    deps.bus.publish({
      type: "sync.progress",
      accountId: run.account.id,
      fetched: transactions.length,
    });
    const next = result.continuation_key;
    if (next === null || next === undefined || next === "") return { transactions, skipped };
    if (seenKeys.has(next)) throw new SyncAbortError(PAGINATION_LOOP);
    seenKeys.add(next);
    continuationKey = next;
  }
  throw new SyncAbortError(PAGINATION_LOOP);
}

/** Network only: balances and transaction pages. Nothing is written until `storeAccountData`. */
async function fetchAccountData(
  deps: SyncDeps,
  run: ActiveRun,
  uid: string,
  today: LocalDate,
): Promise<FetchedData> {
  const balances = await deps.api.getBalances(uid, run.psu);
  const window = transactionWindow(deps.repo, run.account.id, run.trigger, today);
  try {
    const pages = await fetchTransactionPages(deps, run, uid, window);
    return { balances, ...pages, windowStart: window.dateFrom };
  } catch (error) {
    const periodRefused =
      window.strategy === "default" &&
      error instanceof EnableBankingError &&
      error.code === "WRONG_TRANSACTIONS_PERIOD";
    if (!periodRefused) throw error;
    deps.logger.info(
      { accountId: run.account.id },
      "The bank refused the incremental period; fetching the longest available history",
    );
    const longest: TransactionWindow = { strategy: "longest", dateFrom: null };
    const pages = await fetchTransactionPages(deps, run, uid, longest);
    return { balances, ...pages, windowStart: null };
  }
}

/** A provider value Bursar cannot turn into a number or a currency: skip that item only. */
function isProviderDataError(error: unknown): boolean {
  return error instanceof MoneyParseError || error instanceof RangeError;
}

interface StoredCounts {
  inserted: number;
  updated: number;
  removed: number;
  /** Provider items left out: dropped by the client plus those normalisation could not read. */
  skipped: number;
}

/**
 * Writes balances and transactions, or returns null when the account was removed or purged while
 * the bank answered (nothing is written then). One unreadable item (a malformed amount, an
 * unknown currency) is skipped and counted; it never fails the run, because the same item comes
 * back every day and would otherwise stop the account from syncing for good.
 *
 * `existing` is every stored row of the account (Task 12's precondition): the bank may ignore
 * `date_from` (the Mock ASPSP does, eb-api-notes §7) or filter on another date, and a stored
 * entry it returns from before the window must be matched, not inserted a second time.
 */
function storeAccountData(
  deps: SyncDeps,
  run: ActiveRun,
  data: FetchedData,
  today: LocalDate,
): StoredCounts | null {
  const accountId = run.account.id;
  if (!isLiveAccount(deps, accountId)) return null;
  let skipped = data.skipped;
  const fetchedAt = deps.now();
  for (const balance of data.balances) {
    try {
      const normalized = normalizeBalance(balance, fetchedAt, deps.timezone);
      deps.repo.upsertBalance({ accountId, ...normalized, fetchedAt });
    } catch (error) {
      if (!isProviderDataError(error)) throw error;
      skipped += 1;
    }
  }
  const normalized: NormalizedTransaction[] = [];
  for (const tx of data.transactions) {
    try {
      normalized.push(normalizeTransaction(tx, today));
    } catch (error) {
      if (!isProviderDataError(error)) throw error;
      skipped += 1;
    }
  }
  const plan = planReconciliation({
    existing: deps.repo.transactionsSince(accountId, null),
    fetched: assignFingerprints(accountId, normalized),
    windowStart: data.windowStart,
  });
  return { ...applyReconciliation(deps.repo, accountId, plan, deps.now()), skipped };
}

function nextAttemptAt(now: number, attempt: { number: number; max: number }): number | null {
  return attempt.number < attempt.max ? now + backoffMs(attempt.number) : null;
}

function reauthStatus(code: string): "expired" | "revoked" | "error" {
  if (code === "EXPIRED_SESSION") return "expired";
  if (code === "REVOKED_SESSION") return "revoked";
  return "error";
}

/** Finishes the run for a thrown error; returns the outcome or rethrows for the queue. */
function failRun(
  deps: SyncDeps,
  run: ActiveRun,
  error: unknown,
  attempt: { number: number; max: number },
): SyncOutcome {
  const now = deps.now();
  if (!isLiveAccount(deps, run.account.id)) {
    // Removed or purged while the bank answered: record the run, no side effect, no retry.
    return finishRun(deps, run, emptyOutcome("skipped", { skipReason: "account_inactive" }));
  }
  if (error instanceof MoneyParseError) {
    finishRun(deps, run, emptyOutcome("failed", { errorCode: INVALID_PROVIDER_DATA }), {
      errorMessage: "The bank sent an amount Bursar cannot read",
    });
    // Deterministic: the same data comes back on a retry, so retrying only spends the cap.
    throw new PermanentJobError(INVALID_PROVIDER_DATA);
  }
  if (error instanceof SyncAbortError) {
    finishRun(deps, run, emptyOutcome("failed", { errorCode: error.code }), {
      errorMessage: "The bank kept returning more transaction pages",
    });
    throw new PermanentJobError(error.code);
  }
  if (!(error instanceof EnableBankingError)) {
    deps.logger.error(
      { accountId: run.account.id, errorName: error instanceof Error ? error.name : "unknown" },
      "Account sync failed unexpectedly",
    );
    finishRun(
      deps,
      run,
      emptyOutcome("failed", { errorCode: INTERNAL_ERROR, retryAt: nextAttemptAt(now, attempt) }),
      { errorMessage: "Unexpected error while syncing" },
    );
    throw error;
  }
  const code = error.code ?? `HTTP_${error.status}`;
  const errorMessage = error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  switch (error.kind) {
    case "reauth":
      markConnectionEnded(
        statusDeps(deps),
        run.account.connectionId,
        reauthStatus(code),
        { code, message: errorMessage },
        run.sessionId,
      );
      return finishRun(deps, run, emptyOutcome("failed", { errorCode: code }), { errorMessage });
    case "account": {
      // Only while the account still holds the uid the bank refused (a renewal replaces it).
      const sameUid = deps.repo.getAccount(run.account.id)?.providerAccountUid === run.uid;
      return finishRun(deps, run, emptyOutcome("failed", { errorCode: code }), {
        errorMessage,
        ...(sameUid ? { accountPatch: { status: "unavailable" } } : {}),
      });
    }
    case "rate_limited": {
      const retryAt = now + RATE_LIMIT_PAUSE_MS;
      return finishRun(
        deps,
        run,
        emptyOutcome("skipped", { errorCode: code, skipReason: "rate_limited", retryAt }),
        { errorMessage, accountPatch: { rateLimitedUntil: retryAt } },
      );
    }
    case "retry":
      finishRun(
        deps,
        run,
        emptyOutcome("failed", { errorCode: code, retryAt: nextAttemptAt(now, attempt) }),
        { errorMessage },
      );
      throw error;
    default:
      // "fatal": a request Bursar should not have made; retrying cannot help.
      finishRun(deps, run, emptyOutcome("failed", { errorCode: code }), { errorMessage });
      throw new PermanentJobError(code);
  }
}

/**
 * One sync of one account: preflight skips, background cap, balances, paged transactions,
 * reconciliation. Resolves with the outcome; rejects (after recording the run) with the bank
 * error for retryable failures and with `PermanentJobError` for fatal ones.
 */
export async function runAccountSync(
  deps: SyncDeps,
  payload: SyncAccountPayload,
  attempt: { number: number; max: number },
): Promise<SyncOutcome> {
  const account = deps.repo.getAccount(payload.accountId);
  if (!account) {
    deps.logger.warn({ accountId: payload.accountId }, "Account sync skipped: unknown account");
    return emptyOutcome("skipped", { skipReason: "account_inactive" });
  }
  const now = deps.now();
  const check = preflight(deps, account, deps.repo.getConnection(account.connectionId), now);
  if (check.kind === "skip") {
    return recordSkip(deps, account, payload.trigger, check.reason, check.retryAt);
  }

  const today = toLocalDate(now, deps.timezone);
  const cap = deps.settings.get().backgroundSyncCap;
  const psu = forwardedPsu(payload);
  // The initial sync is charged once per job, not per attempt: full history is often available
  // only for about an hour after the consent (spec §3), so its retries must not hit the cap.
  const charge = !(payload.trigger === "initial" && attempt.number > 1);
  if (!psu && charge && !deps.repo.tryConsumeBackgroundFetch(account.id, today, cap)) {
    return recordSkip(deps, account, payload.trigger, "daily_cap", null);
  }

  const run: ActiveRun = {
    id: deps.repo.startSyncRun(
      newRun(account.id, payload.trigger, now, {
        status: "running",
        withPsuHeaders: psu !== undefined,
      }),
    ),
    account,
    trigger: payload.trigger,
    psu,
    sessionId: check.sessionId,
    uid: check.uid,
  };
  deps.bus.publish({
    type: "sync.started",
    accountId: account.id,
    connectionId: account.connectionId,
    trigger: payload.trigger,
  });

  try {
    let data: FetchedData;
    try {
      data = await fetchAccountData(deps, run, run.uid, today);
    } catch (error) {
      if (run.psu === undefined || !isPsuHeaderError(error)) throw error;
      deps.logger.warn(
        { accountId: account.id, errorCode: error.code },
        "The bank refused the PSU headers; retrying as a background fetch",
      );
      run.psu = undefined;
      if (!deps.repo.tryConsumeBackgroundFetch(account.id, today, cap)) {
        return finishRun(deps, run, emptyOutcome("skipped", { skipReason: "daily_cap" }));
      }
      data = await fetchAccountData(deps, run, run.uid, today);
    }
    const stored = storeAccountData(deps, run, data, today);
    if (stored === null) {
      return finishRun(deps, run, emptyOutcome("skipped", { skipReason: "account_inactive" }));
    }
    const { skipped, ...counts } = stored;
    return finishRun(
      deps,
      run,
      emptyOutcome("succeeded", { fetched: data.transactions.length, ...counts }),
      skipped > 0 ? { errorMessage: `${skipped} provider entries skipped` } : {},
    );
  } catch (error) {
    return failRun(deps, run, error, attempt);
  }
}

export function syncAccountHandler(deps: SyncDeps): JobHandler {
  return async (job) => {
    const payload = parsePayload(syncAccountPayloadSchema, job);
    await runAccountSync(deps, payload, { number: job.attempts, max: job.maxAttempts });
  };
}

/** Registered instead of `syncAccountHandler` when Enable Banking is not configured. */
export function unconfiguredSyncHandler(): JobHandler {
  return async () => {
    throw new PermanentJobError("banking_not_configured");
  };
}

export function enqueueAccountSync(
  queue: JobQueue,
  accountId: number,
  trigger: SyncTrigger,
  psu?: PsuHeaders,
): { id: number; created: boolean } {
  const payload: SyncAccountPayload = psu ? { accountId, trigger, psu } : { accountId, trigger };
  return queue.enqueueUnique(SYNC_ACCOUNT_JOB, syncDedupeKey(accountId), payload, {
    maxAttempts: SYNC_MAX_ATTEMPTS,
  });
}
