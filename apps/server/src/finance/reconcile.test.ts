import type { LocalDate } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EbTransaction } from "../eb/schemas";
import { createTestDatabase, type TestDatabase } from "../test/db";
import {
  assignFingerprints,
  type FingerprintedTransaction,
  normalizeTransaction,
} from "./normalize";
import {
  applyReconciliation,
  DEFAULT_PENDING_MATCH_DAYS,
  PENDING_REMOVAL_THRESHOLD,
  planReconciliation,
  type ReconcilePlan,
} from "./reconcile";
import { FinanceRepository, type TransactionRow } from "./repository";

const T0 = Date.UTC(2026, 10, 9, 8, 0, 0);
const HOUR = 3_600_000;
const TODAY: LocalDate = "2026-11-09";

/** A booked card payment without reference, shaped like an Enable Banking `Transaction`. */
function booked(overrides: Partial<EbTransaction> = {}): EbTransaction {
  return {
    entry_reference: null,
    transaction_id: null,
    transaction_amount: { currency: "EUR", amount: "12.40" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    booking_date: "2026-11-05",
    value_date: "2026-11-05",
    transaction_date: "2026-11-04",
    creditor: { name: "Northwind Grocers" },
    creditor_account: null,
    debtor: null,
    debtor_account: null,
    remittance_information: ["Card payment store 12"],
    bank_transaction_code: { description: "Card payment", code: "PMNT", sub_code: "CCRD" },
    merchant_category_code: "5411",
    balance_after_transaction: null,
    reference_number: null,
    ...overrides,
  };
}

/** The same payment while it is still pending: no booking or value date yet. */
function pending(overrides: Partial<EbTransaction> = {}): EbTransaction {
  return booked({ status: "PDNG", booking_date: null, value_date: null, ...overrides });
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`No item at index ${index}`);
  return item;
}

let t: TestDatabase;
let repo: FinanceRepository;
let accountId: number;
let clock: number;

function seedAccount(db: TestDatabase): number {
  const connection = db.sqlite
    .prepare(
      "INSERT INTO bank_connections (aspsp_name, aspsp_country, provider_session_id, valid_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "Banca Esempio",
      "IT",
      "3f0c6a52-6a4e-4c8e-9a51-2b7d8e4f1a90",
      T0 + 90 * 24 * HOUR,
      T0,
      T0,
    );
  const account = db.sqlite
    .prepare(
      "INSERT INTO accounts (connection_id, identification_hash, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(connection.lastInsertRowid, "fictional-identification-hash-1", "EUR", T0, T0);
  return Number(account.lastInsertRowid);
}

beforeEach(() => {
  t = createTestDatabase();
  clock = T0;
  repo = new FinanceRepository(t.db, () => clock);
  accountId = seedAccount(t);
});

afterEach(() => t.dispose());

function fingerprint(txs: readonly EbTransaction[]): FingerprintedTransaction[] {
  return assignFingerprints(
    accountId,
    txs.map((tx) => normalizeTransaction(tx, TODAY)),
  );
}

function rows(): TransactionRow[] {
  return [...repo.transactionsSince(accountId, null)].sort((a, b) => a.id - b.id);
}

/** One sync round: plan against every stored row, apply at the current clock, advance one hour. */
function sync(txs: readonly EbTransaction[], windowStart: LocalDate | null = null) {
  const plan = planReconciliation({
    existing: repo.transactionsSince(accountId, null),
    fetched: fingerprint(txs),
    windowStart,
  });
  const counts = applyReconciliation(repo, accountId, plan, clock);
  clock += HOUR;
  return { plan, counts };
}

describe("constants", () => {
  it("removes pending rows after two misses and matches within seven days", () => {
    expect(PENDING_REMOVAL_THRESHOLD).toBe(2);
    expect(DEFAULT_PENDING_MATCH_DAYS).toBe(7);
  });
});

describe("planReconciliation and applyReconciliation", () => {
  it("inserts new transactions with first and last seen set to now", () => {
    const groceries = booked({ entry_reference: "E-1" });
    const salary = booked({
      entry_reference: "E-2",
      transaction_amount: { currency: "EUR", amount: "2500.00" },
      credit_debit_indicator: "CRDT",
      creditor: null,
      debtor: { name: "Example Employer" },
      remittance_information: ["Salary November"],
    });
    const { counts } = sync([groceries, salary]);
    expect(counts).toEqual({ inserted: 2, updated: 0, removed: 0 });
    const [first, second] = [at(rows(), 0), at(rows(), 1)];
    expect(first).toMatchObject({
      accountId,
      providerReference: "E-1",
      fingerprint: "ref:E-1",
      status: "booked",
      sortDate: "2026-11-05",
      amountMinor: -1240,
      currency: "EUR",
      counterparty: "Northwind Grocers",
      searchText: "northwind grocers card payment store 12",
      bankCode: { code: "PMNT", subCode: "CCRD", description: "Card payment" },
      missingCount: 0,
      firstSeenAt: T0,
      lastSeenAt: T0,
    });
    expect(JSON.parse(first.rawJson)).toEqual(groceries);
    expect(second).toMatchObject({
      providerReference: "E-2",
      amountMinor: 250000,
      counterparty: "Example Employer",
      searchText: "example employer salary november",
    });
  });

  it("deduplicates by entry reference across two syncs", () => {
    sync([booked({ entry_reference: "E-1", transaction_id: "TX-A" })]);
    const original = at(rows(), 0);
    const { plan, counts } = sync([
      booked({
        entry_reference: "E-1",
        transaction_id: "TX-B",
        remittance_information: ["Card payment store 12", "Receipt 3391"],
      }),
    ]);
    expect(counts).toEqual({ inserted: 0, updated: 1, removed: 0 });
    expect(plan.updates).toEqual([
      {
        id: original.id,
        tx: expect.objectContaining({ fingerprint: "ref:E-1" }),
        replacedPending: false,
      },
    ]);
    expect(rows()).toEqual([
      expect.objectContaining({
        id: original.id,
        remittance: "Card payment store 12 Receipt 3391",
        firstSeenAt: T0,
        lastSeenAt: T0 + HOUR,
      }),
    ]);
  });

  it("deduplicates by fingerprint when there is no reference", () => {
    sync([booked()]);
    const { counts } = sync([booked()]);
    expect(counts).toEqual({ inserted: 0, updated: 1, removed: 0 });
    expect(rows()).toHaveLength(1);
  });

  it("keeps two identical same-day payments as two rows across re-syncs", () => {
    expect(sync([booked(), booked()]).counts.inserted).toBe(2);
    const before = rows();
    expect(before.map((row) => row.fingerprint.slice(-2))).toEqual(["#1", "#2"]);
    const { counts } = sync([booked(), booked()]);
    expect(counts).toEqual({ inserted: 0, updated: 2, removed: 0 });
    expect(rows().map((row) => [row.id, row.fingerprint])).toEqual(
      before.map((row) => [row.id, row.fingerprint]),
    );
  });

  it("collapses a reference repeated in the same batch", () => {
    const { counts } = sync([
      booked({ entry_reference: "E-1" }),
      booked({ entry_reference: "E-1" }),
    ]);
    expect(counts).toEqual({ inserted: 1, updated: 0, removed: 0 });
    expect(rows()).toHaveLength(1);
  });

  it("prefers the booked entry when a batch lists one reference as pending and booked", () => {
    sync([pending({ entry_reference: "E-1" }), booked({ entry_reference: "E-1" })]);
    expect(rows()).toEqual([expect.objectContaining({ fingerprint: "ref:E-1", status: "booked" })]);
  });

  it("replaces a pending row with its booked counterpart by reference", () => {
    sync([pending({ entry_reference: "E-1" })]);
    const pendingRow = at(rows(), 0);
    expect(pendingRow.status).toBe("pending");
    const { plan, counts } = sync([booked({ entry_reference: "E-1" })]);
    expect(plan.updates).toEqual([
      {
        id: pendingRow.id,
        tx: expect.objectContaining({ status: "booked", fingerprint: "ref:E-1" }),
        replacedPending: true,
      },
    ]);
    expect(counts).toEqual({ inserted: 0, updated: 1, removed: 0 });
    expect(rows()).toEqual([
      expect.objectContaining({
        id: pendingRow.id,
        status: "booked",
        bookingDate: "2026-11-05",
        missingCount: 0,
        firstSeenAt: T0,
        lastSeenAt: T0 + HOUR,
      }),
    ]);
  });

  it("replaces a pending row with a booked entry that carries a new reference", () => {
    sync([pending({ entry_reference: "P-1" })]);
    const pendingRow = at(rows(), 0);
    const { plan } = sync([booked({ entry_reference: "B-1" })]);
    expect(plan.updates.map((update) => [update.id, update.replacedPending])).toEqual([
      [pendingRow.id, true],
    ]);
    expect(rows()).toEqual([
      expect.objectContaining({
        id: pendingRow.id,
        providerReference: "B-1",
        fingerprint: "ref:B-1",
        status: "booked",
      }),
    ]);
  });

  it("replaces a pending row heuristically by amount, currency and counterparty", () => {
    sync([pending()]);
    const pendingRow = at(rows(), 0);
    expect(pendingRow.fingerprint.startsWith("pending:")).toBe(true);
    const { plan, counts } = sync([booked()]);
    expect(plan.updates.map((update) => [update.id, update.replacedPending])).toEqual([
      [pendingRow.id, true],
    ]);
    expect(counts).toEqual({ inserted: 0, updated: 1, removed: 0 });
    const row = at(rows(), 0);
    expect(rows()).toHaveLength(1);
    expect(row).toMatchObject({ id: pendingRow.id, status: "booked", firstSeenAt: T0 });
    expect(row.fingerprint.startsWith("fp:")).toBe(true);
  });

  it("matches a pending row exactly seven days apart", () => {
    sync([pending({ transaction_date: "2026-10-29" })]);
    const { plan } = sync([booked({ booking_date: "2026-11-05" })]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates.map((update) => update.replacedPending)).toEqual([true]);
  });

  it("refuses a heuristic match beyond seven days", () => {
    sync([pending({ transaction_date: "2026-10-28" })]);
    const pendingRow = at(rows(), 0);
    const { plan, counts } = sync([booked({ booking_date: "2026-11-05" })]);
    expect(counts).toEqual({ inserted: 1, updated: 0, removed: 0 });
    expect(plan.missingPending).toEqual([{ id: pendingRow.id, missingCount: 1 }]);
    expect(rows().map((row) => row.status)).toEqual(["pending", "booked"]);
  });

  it("refuses a heuristic match with a different amount or currency", () => {
    sync([pending()]);
    const { plan, counts } = sync([
      booked({ transaction_amount: { currency: "EUR", amount: "12.41" } }),
      booked({ transaction_amount: { currency: "USD", amount: "12.40" } }),
    ]);
    expect(plan.updates).toEqual([]);
    expect(counts).toEqual({ inserted: 2, updated: 0, removed: 0 });
    expect(rows().map((row) => row.status)).toEqual(["pending", "booked", "booked"]);
  });

  it("refuses a heuristic match with a different counterparty", () => {
    sync([pending()]);
    const { plan } = sync([booked({ creditor: { name: "Contoso Pharmacy" } })]);
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toHaveLength(1);
  });

  it("matches entries without a counterparty only when the remittance is equal", () => {
    sync([pending({ creditor: null, remittance_information: ["ATM withdrawal 0042"] })]);
    const existing = rows();
    const different = planReconciliation({
      existing,
      fetched: fingerprint([
        booked({ creditor: null, remittance_information: ["ATM withdrawal 0043"] }),
      ]),
      windowStart: null,
    });
    expect(different.updates).toEqual([]);
    expect(different.inserts).toHaveLength(1);
    const same = planReconciliation({
      existing,
      fetched: fingerprint([
        booked({ creditor: null, remittance_information: ["ATM withdrawal 0042"] }),
      ]),
      windowStart: null,
    });
    expect(same.updates).toEqual([
      {
        id: at(existing, 0).id,
        tx: expect.objectContaining({ counterparty: null }),
        replacedPending: true,
      },
    ]);
  });

  it("uses the oldest pending row first", () => {
    sync([
      pending({ transaction_date: "2026-11-03" }),
      pending({ transaction_date: "2026-11-04" }),
    ]);
    const [older, newer] = [at(rows(), 0), at(rows(), 1)];
    const { plan } = sync([booked({ booking_date: "2026-11-05" })]);
    expect(plan.updates.map((update) => [update.id, update.replacedPending])).toEqual([
      [older.id, true],
    ]);
    expect(plan.missingPending).toEqual([{ id: newer.id, missingCount: 1 }]);
  });

  it("uses each pending row once", () => {
    sync([
      pending({ transaction_date: "2026-11-03" }),
      pending({ transaction_date: "2026-11-04" }),
    ]);
    const [older, newer] = [at(rows(), 0), at(rows(), 1)];
    const { counts } = sync([
      booked({ booking_date: "2026-11-06", value_date: "2026-11-06" }),
      booked({ booking_date: "2026-11-05" }),
    ]);
    expect(counts).toEqual({ inserted: 0, updated: 2, removed: 0 });
    expect(rows().map((row) => [row.id, row.status, row.bookingDate])).toEqual([
      [older.id, "booked", "2026-11-05"],
      [newer.id, "booked", "2026-11-06"],
    ]);
  });

  it("removes a pending row after two consecutive misses and keeps it after one", () => {
    sync([pending()]);
    const id = at(rows(), 0).id;
    const first = sync([]);
    expect(first.plan.missingPending).toEqual([{ id, missingCount: 1 }]);
    expect(first.counts).toEqual({ inserted: 0, updated: 0, removed: 0 });
    expect(at(rows(), 0).missingCount).toBe(1);
    const second = sync([]);
    expect(second.plan.deletes).toEqual([id]);
    expect(second.counts).toEqual({ inserted: 0, updated: 0, removed: 1 });
    expect(rows()).toEqual([]);
  });

  it("resets the miss counter when the pending row comes back", () => {
    sync([pending()]);
    const id = at(rows(), 0).id;
    sync([]);
    const back = sync([pending()]);
    expect(back.plan.seenPending).toEqual([id]);
    expect(back.plan.updates).toEqual([
      { id, tx: expect.objectContaining({ status: "pending" }), replacedPending: false },
    ]);
    expect(at(rows(), 0).missingCount).toBe(0);
    const missedOnce = sync([]);
    expect(missedOnce.plan.deletes).toEqual([]);
    expect(rows()).toEqual([expect.objectContaining({ id, missingCount: 1 })]);
  });

  it("leaves pending rows before the window start untouched", () => {
    sync([
      pending({ transaction_date: "2026-10-01" }),
      pending({ transaction_date: "2026-10-29" }),
    ]);
    const [outside, edge] = [at(rows(), 0), at(rows(), 1)];
    const first = sync([], "2026-10-29");
    expect(first.plan.missingPending).toEqual([{ id: edge.id, missingCount: 1 }]);
    const second = sync([], "2026-10-29");
    expect(second.plan.deletes).toEqual([edge.id]);
    expect(rows()).toEqual([expect.objectContaining({ id: outside.id, missingCount: 0 })]);
  });

  it("deletes the pending row that a cancelled entry refers to", () => {
    sync([pending({ entry_reference: "E-1" })]);
    const id = at(rows(), 0).id;
    const { plan, counts } = sync([pending({ entry_reference: "E-1", status: "CNCL" })]);
    expect(plan.deletes).toEqual([id]);
    expect(plan.inserts).toEqual([]);
    expect(counts).toEqual({ inserted: 0, updated: 0, removed: 1 });
    expect(rows()).toEqual([]);
  });

  it("deletes a pending row cancelled without a reference by fingerprint", () => {
    sync([pending()]);
    const id = at(rows(), 0).id;
    const { plan } = sync([pending({ status: "RJCT" })]);
    expect(plan.deletes).toEqual([id]);
    expect(rows()).toEqual([]);
  });

  it("never inserts a cancelled entry", () => {
    const { counts } = sync([
      booked({ status: "CNCL", entry_reference: "E-9" }),
      booked({ status: "RJCT" }),
    ]);
    expect(counts).toEqual({ inserted: 0, updated: 0, removed: 0 });
    expect(rows()).toEqual([]);
  });

  it("never deletes booked rows", () => {
    sync([booked({ entry_reference: "E-1" }), booked()]);
    for (let round = 0; round < 3; round += 1) {
      const { plan } = sync([]);
      expect(plan.deletes).toEqual([]);
      expect(plan.missingPending).toEqual([]);
    }
    const { plan } = sync([booked({ entry_reference: "E-1", status: "CNCL" })]);
    expect(plan.deletes).toEqual([]);
    expect(rows().map((row) => row.status)).toEqual(["booked", "booked"]);
  });

  it("does not downgrade a booked row reported again as pending", () => {
    sync([booked({ entry_reference: "E-1" })]);
    const { plan } = sync([pending({ entry_reference: "E-1" })]);
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(rows()).toEqual([expect.objectContaining({ status: "booked", lastSeenAt: T0 })]);
  });

  it("is pure: the same input gives the same plan and stays untouched", () => {
    sync([pending()]);
    const existing = rows();
    const fetched = fingerprint([booked(), pending({ entry_reference: "E-5" })]);
    const snapshot = structuredClone({ existing, fetched });
    const first = planReconciliation({ existing, fetched, windowStart: null });
    const second = planReconciliation({ existing, fetched, windowStart: null });
    expect(second).toEqual(first);
    expect({ existing, fetched }).toEqual(snapshot);
  });

  it("honours a custom pendingMatchDays", () => {
    sync([pending({ transaction_date: "2026-11-02" })]);
    const existing = rows();
    const fetched = fingerprint([booked({ booking_date: "2026-11-05" })]);
    expect(
      planReconciliation({ existing, fetched, windowStart: null, pendingMatchDays: 2 }).updates,
    ).toEqual([]);
    expect(planReconciliation({ existing, fetched, windowStart: null }).updates).toHaveLength(1);
  });

  it("rolls back the whole plan when one write fails", () => {
    sync([booked({ entry_reference: "E-1" }), pending({ entry_reference: "P-1" })]);
    const before = rows();
    const plan = planReconciliation({
      existing: before,
      fetched: fingerprint([
        booked({
          entry_reference: "E-2",
          transaction_amount: { currency: "EUR", amount: "99.00" },
          creditor: { name: "Contoso Pharmacy" },
        }),
        pending({ entry_reference: "P-1", status: "CNCL" }),
      ]),
      windowStart: null,
    });
    expect(plan.deletes).toHaveLength(1);
    expect(plan.inserts).toHaveLength(1);
    // A second insert with the fingerprint of an existing row violates the unique index.
    const broken: ReconcilePlan = {
      ...plan,
      inserts: [...plan.inserts, at(fingerprint([booked({ entry_reference: "E-1" })]), 0)],
    };
    expect(() => applyReconciliation(repo, accountId, broken, clock)).toThrow();
    expect(rows()).toEqual(before);
    expect(applyReconciliation(repo, accountId, plan, clock)).toEqual({
      inserted: 1,
      updated: 0,
      removed: 1,
    });
    expect(rows().map((row) => row.providerReference)).toEqual(["E-1", "E-2"]);
  });

  it("keeps one row and its first day for a date-less pending entry synced on two days", () => {
    const hold = pending({ transaction_date: null });
    const round = (today: LocalDate) => {
      const plan = planReconciliation({
        existing: repo.transactionsSince(accountId, null),
        fetched: assignFingerprints(accountId, [normalizeTransaction(hold, today)]),
        windowStart: null,
      });
      const counts = applyReconciliation(repo, accountId, plan, clock);
      clock += 24 * HOUR;
      return counts;
    };
    expect(round("2026-11-09")).toEqual({ inserted: 1, updated: 0, removed: 0 });
    expect(round("2026-11-10")).toEqual({ inserted: 0, updated: 1, removed: 0 });
    expect(rows()).toHaveLength(1);
    expect(at(rows(), 0)).toMatchObject({
      status: "pending",
      sortDate: "2026-11-09",
      firstSeenAt: T0,
      lastSeenAt: T0 + 24 * HOUR,
      missingCount: 0,
    });
  });
});
