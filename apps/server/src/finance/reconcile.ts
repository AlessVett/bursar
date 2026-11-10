import { diffDays, type LocalDate } from "@bursar/shared";
import { type FingerprintedTransaction, hasProviderDate, normalizeCounterparty } from "./normalize";
import type { FinanceRepository, NewTransaction, TransactionRow } from "./repository";

/**
 * Reconciliation of one fetched batch with the stored transactions of an account (spec §6.3).
 *
 * `planReconciliation` is pure: it decides what to insert, refresh, count as missing and delete.
 * `applyReconciliation` writes that plan in one database transaction. Booked rows are never deleted;
 * pending rows are replaced in place by their booked counterpart (same row id and first-seen time),
 * deleted when a cancellation names them, or deleted after `PENDING_REMOVAL_THRESHOLD` consecutive
 * syncs that cover their date without listing them.
 */

export const PENDING_REMOVAL_THRESHOLD = 2;
export const DEFAULT_PENDING_MATCH_DAYS = 7;

export interface ReconcilePlan {
  inserts: FingerprintedTransaction[];
  updates: { id: number; tx: FingerprintedTransaction; replacedPending: boolean }[];
  /** Ids of pending rows the batch still lists as pending (also present in `updates`). */
  seenPending: number[];
  missingPending: { id: number; missingCount: number }[];
  deletes: number[];
}

/** Which entry survives when a batch lists the same fingerprint twice. */
const PRECEDENCE: Readonly<Record<FingerprintedTransaction["status"], number>> = {
  pending: 0,
  cancelled: 1,
  booked: 2,
};

function dedupeByFingerprint(
  fetched: readonly FingerprintedTransaction[],
): FingerprintedTransaction[] {
  const byFingerprint = new Map<string, FingerprintedTransaction>();
  for (const tx of fetched) {
    const current = byFingerprint.get(tx.fingerprint);
    if (current === undefined || PRECEDENCE[tx.status] > PRECEDENCE[current.status]) {
      byFingerprint.set(tx.fingerprint, tx);
    }
  }
  return [...byFingerprint.values()];
}

function compareDates(a: LocalDate, b: LocalDate): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function sameCounterparty(tx: FingerprintedTransaction, row: TransactionRow): boolean {
  const name = normalizeCounterparty(tx.counterparty);
  if (name !== normalizeCounterparty(row.counterparty)) return false;
  // Two unnamed entries are the same counterparty only when their remittance text is equal
  // (equal text is equivalent to the equal remittance hash used by the fingerprint).
  return name !== "" || (tx.remittance ?? "") === (row.remittance ?? "");
}

function isHeuristicMatch(
  tx: FingerprintedTransaction,
  row: TransactionRow,
  matchDays: number,
): boolean {
  return (
    tx.amountMinor === row.amountMinor &&
    tx.currency === row.currency &&
    Math.abs(diffDays(tx.sortDate, row.sortDate)) <= matchDays &&
    sameCounterparty(tx, row)
  );
}

export function planReconciliation(input: {
  existing: readonly TransactionRow[];
  fetched: readonly FingerprintedTransaction[];
  windowStart: LocalDate | null;
  pendingMatchDays?: number;
}): ReconcilePlan {
  const matchDays = input.pendingMatchDays ?? DEFAULT_PENDING_MATCH_DAYS;
  const fetched = dedupeByFingerprint(input.fetched);
  const byFingerprint = new Map<string, TransactionRow>();
  for (const row of input.existing) byFingerprint.set(row.fingerprint, row);
  const pendingRows = input.existing
    .filter((row) => row.status === "pending")
    .sort((a, b) => compareDates(a.sortDate, b.sortDate) || a.id - b.id);
  const claimed = new Set<number>();
  const plan: ReconcilePlan = {
    inserts: [],
    updates: [],
    seenPending: [],
    missingPending: [],
    deletes: [],
  };

  // 1. Pending entries refresh their row or are inserted; cancelled entries delete their pending row.
  for (const tx of fetched) {
    if (tx.status === "booked") continue;
    const row = byFingerprint.get(tx.fingerprint);
    if (tx.status === "pending") {
      if (row === undefined) {
        plan.inserts.push(tx);
      } else if (row.status === "pending" && !claimed.has(row.id)) {
        claimed.add(row.id);
        plan.updates.push({ id: row.id, tx, replacedPending: false });
        plan.seenPending.push(row.id);
      }
      // A booked row reported again as pending is left as it is.
      continue;
    }
    const target =
      row !== undefined
        ? row
        : pendingRows.find(
            (candidate) =>
              tx.providerReference !== null && candidate.providerReference === tx.providerReference,
          );
    if (target !== undefined && target.status === "pending" && !claimed.has(target.id)) {
      claimed.add(target.id);
      plan.deletes.push(target.id);
    }
  }

  // 2. Booked entries whose fingerprint is stored refresh that row (a pending row with the same
  //    reference becomes booked here).
  const unmatched: FingerprintedTransaction[] = [];
  for (const tx of fetched) {
    if (tx.status !== "booked") continue;
    const row = byFingerprint.get(tx.fingerprint);
    if (row === undefined) {
      unmatched.push(tx);
      continue;
    }
    if (claimed.has(row.id)) continue;
    claimed.add(row.id);
    plan.updates.push({ id: row.id, tx, replacedPending: row.status === "pending" });
  }

  // 3. Other booked entries replace a pending row: by reference first, then by the heuristic,
  //    oldest booked entry and oldest pending row first, each pending row once.
  const replaced = new Set<FingerprintedTransaction>();
  const oldestFirst = [...unmatched].sort((a, b) => compareDates(a.sortDate, b.sortDate));
  const replace = (tx: FingerprintedTransaction, row: TransactionRow): void => {
    claimed.add(row.id);
    replaced.add(tx);
    plan.updates.push({ id: row.id, tx, replacedPending: true });
  };
  for (const tx of oldestFirst) {
    if (tx.providerReference === null) continue;
    const row = pendingRows.find(
      (candidate) =>
        !claimed.has(candidate.id) && candidate.providerReference === tx.providerReference,
    );
    if (row !== undefined) replace(tx, row);
  }
  for (const tx of oldestFirst) {
    if (replaced.has(tx)) continue;
    const row = pendingRows.find(
      (candidate) => !claimed.has(candidate.id) && isHeuristicMatch(tx, candidate, matchDays),
    );
    if (row !== undefined) replace(tx, row);
  }
  for (const tx of unmatched) {
    if (!replaced.has(tx)) plan.inserts.push(tx);
  }

  // 4. Pending rows inside the fetched window that the batch did not list.
  for (const row of pendingRows) {
    if (claimed.has(row.id)) continue;
    if (input.windowStart !== null && row.sortDate < input.windowStart) continue;
    const missingCount = row.missingCount + 1;
    if (missingCount >= PENDING_REMOVAL_THRESHOLD) plan.deletes.push(row.id);
    else plan.missingPending.push({ id: row.id, missingCount });
  }

  plan.seenPending.sort((a, b) => a - b);
  plan.missingPending.sort((a, b) => a.id - b.id);
  plan.deletes.sort((a, b) => a - b);
  return plan;
}

type StoredFields = Omit<
  NewTransaction,
  "accountId" | "missingCount" | "firstSeenAt" | "lastSeenAt"
>;

function storedFields(tx: FingerprintedTransaction): StoredFields {
  if (tx.status === "cancelled") throw new Error("A cancelled transaction is never stored");
  return {
    providerReference: tx.providerReference,
    fingerprint: tx.fingerprint,
    status: tx.status,
    bookingDate: tx.bookingDate,
    valueDate: tx.valueDate,
    transactionDate: tx.transactionDate,
    sortDate: tx.sortDate,
    amountMinor: tx.amountMinor,
    currency: tx.currency,
    counterparty: tx.counterparty,
    counterpartyAccount: tx.counterpartyAccount,
    remittance: tx.remittance,
    bankCode: tx.bankCode,
    merchantCategoryCode: tx.merchantCategoryCode,
    balanceAfterMinor: tx.balanceAfterMinor,
    searchText: tx.searchText,
    rawJson: JSON.stringify(tx.raw),
  };
}

/**
 * The fields a refresh writes. Without any provider date the stored `sortDate` is the day the
 * entry was first seen: keep it, so a date-less pending entry does not move forward every day.
 */
function refreshFields(tx: FingerprintedTransaction): Partial<StoredFields> {
  const { sortDate, ...rest } = storedFields(tx);
  return hasProviderDate(tx) ? { ...rest, sortDate } : rest;
}

/**
 * Writes a plan in one repository transaction: deletes, refreshes (which reset `missingCount` and
 * keep `firstSeenAt`), miss counters, inserts. Any failure rolls back every write of the plan.
 */
export function applyReconciliation(
  repo: FinanceRepository,
  accountId: number,
  plan: ReconcilePlan,
  now: number,
): { inserted: number; updated: number; removed: number } {
  return repo.transaction(() => {
    const removed = plan.deletes.length > 0 ? repo.deleteTransactions(plan.deletes) : 0;
    for (const update of plan.updates) {
      repo.updateTransaction(update.id, {
        ...refreshFields(update.tx),
        missingCount: 0,
        lastSeenAt: now,
      });
    }
    for (const missing of plan.missingPending) {
      repo.updateTransaction(missing.id, { missingCount: missing.missingCount });
    }
    for (const tx of plan.inserts) {
      repo.insertTransaction({
        ...storedFields(tx),
        accountId,
        missingCount: 0,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
    return { inserted: plan.inserts.length, updated: plan.updates.length, removed };
  });
}
