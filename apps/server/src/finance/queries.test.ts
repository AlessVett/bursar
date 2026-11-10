import { accountDisplayName, transactionQuerySchema } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../audit";
import { SYNC_ACCOUNT_JOB, syncDedupeKey } from "../jobs/types";
import { createTestDatabase, type TestDatabase } from "../test/db";
import {
  buildWorld,
  DAY_MS,
  FinanceFixture,
  HOUR_MS,
  NOW,
  queryDeps,
  TODAY,
  type World,
} from "../test/finance";
import {
  accountCurrency,
  balanceHistory,
  buildTransactionListSql,
  canonicalizeAmount,
  cashflow,
  getAccountDetail,
  getTransaction,
  homeSummary,
  listConnectionsView,
  listTransactions,
  searchAll,
  updateAccount,
} from "./queries";

const tq = (query: Record<string, string> = {}) => transactionQuerySchema.parse(query);
const backupOk = { target: "s3", consecutiveFailures: 0 } as const;

let t: TestDatabase;
let fx: FinanceFixture;
let w: World;

beforeEach(() => {
  t = createTestDatabase();
  fx = new FinanceFixture(t);
  w = buildWorld(fx);
});
afterEach(() => t.dispose());

function ids(items: { id: number }[]): number[] {
  return items.map((item) => item.id);
}

describe("the locale setting", () => {
  it("is read once per query, not once per row", () => {
    let reads = 0;
    const deps = queryDeps(t, {
      locale: () => {
        reads += 1;
        return "en";
      },
    });
    const run = (name: string, fn: () => unknown) => {
      reads = 0;
      fn();
      expect(reads, name).toBe(1);
    };
    run("listTransactions", () => listTransactions(deps, tq({ pageSize: "10" })));
    run("listConnectionsView", () => listConnectionsView(deps));
    run("homeSummary", () => homeSummary(deps, backupOk));
    run("searchAll", () => searchAll(deps, "caffe"));
    run("getAccountDetail", () => getAccountDetail(deps, w.checking));
    run("getTransaction", () => getTransaction(deps, w.transactions.salary ?? 0));
    run("updateAccount", () =>
      updateAccount({ ...deps, audit: new AuditLog(t.db, () => NOW) }, w.checking, {
        nickname: "Daily",
      }),
    );
  });
});

describe("canonicalizeAmount", () => {
  it.each([
    ["12", null, "12"],
    ["12,5", null, "12.5"],
    ["12.50", null, "12.50"],
    ["-12.50", "-", "12.50"],
    ["+7", "+", "7"],
    ["1.234,56", null, "1234.56"],
    ["1,234.56", null, "1234.56"],
    ["1.234", null, "1234"],
    ["1,234", null, "1.234"],
    ["12.345", null, "12345"],
    ["0.123", null, "0.123"],
    ["12.3456", null, "12.3456"],
    ["1.234.567", null, "1234567"],
    ["1 234,5", null, "1234.5"],
    ["007,5", null, "7.5"],
  ])("reads %s", (input, sign, decimal) => {
    expect(canonicalizeAmount(input)).toEqual({ sign, decimal });
  });

  it.each(["", "abc", "12a", "1.2.3", "1,2,3.4", "12%", "--5", "1.234.5", ".5"])(
    "refuses %s",
    (input) => {
      expect(canonicalizeAmount(input)).toBeNull();
    },
  );
});

describe("listConnectionsView", () => {
  it("lists live connections with their non-removed accounts and effective status", () => {
    const view = listConnectionsView(queryDeps(t));
    expect(view.connections.map((c) => [c.bankName, c.status, c.hasLogo])).toEqual([
      ["Banca Esempio", "active", true],
      ["Northwind Bank", "expiring", false],
    ]);
    const bankA = view.connections[0];
    expect(bankA?.accounts.map((a) => [a.id, a.name, a.status])).toEqual([
      [w.checking, "Conto Esempio", "active"],
      [w.savings, "Rainy day", "active"],
      [w.disabled, "Old card", "disabled"],
    ]);
    expect(bankA).not.toHaveProperty("providerSessionId");
  });

  it("returns each account's balance, 30-day net, sync freshness and sync state", () => {
    const deps = queryDeps(t);
    deps.queue.enqueueUnique(SYNC_ACCOUNT_JOB, syncDedupeKey(w.savings), {
      accountId: w.savings,
      trigger: "manual",
    });
    const accounts = listConnectionsView(deps).connections.flatMap((c) => c.accounts);
    const checking = accounts.find((a) => a.id === w.checking);
    expect(checking).toMatchObject({
      balance: { amountMinor: 500_000, currency: "EUR", type: "CLBD", asOf: NOW },
      // 30 local days ending today: 2026-10-11 is in, 2026-10-10 is out.
      net30d: { inMinor: 250_000, outMinor: 23_450, netMinor: 226_550 },
      lastSyncedAt: NOW - 3 * HOUR_MS,
      lastSyncError: null,
      rateLimitedUntil: null,
      syncInProgress: false,
      iban: "IT60X0542811101000000123456",
      maskedIdentifier: "IT60 •••• •••• 3456",
    });
    // daily30d: the same 30 local days, one bucket each, summing to net30d.
    const days = checking?.daily30d ?? [];
    expect(days).toHaveLength(30);
    expect(days[0]).toMatchObject({ date: "2026-10-11", end: "2026-10-11", balanceMinor: null });
    expect(days[29]?.date).toBe("2026-11-09");
    expect(days.reduce((sum, day) => sum + day.inMinor, 0)).toBe(250_000);
    expect(days.reduce((sum, day) => sum + day.outMinor, 0)).toBe(23_450);
    expect(days.every((day) => day.netMinor === day.inMinor - day.outMinor)).toBe(true);
    expect(accounts.find((a) => a.id === w.savings)?.syncInProgress).toBe(true);
    expect(accounts.find((a) => a.id === w.disabled)).toMatchObject({
      balance: null,
      net30d: { inMinor: 0, outMinor: 999, netMinor: -999 },
    });
  });

  it("prefers the booked balance and the newest snapshot of each type", () => {
    const account = fx.account(w.bankA, { last4: "1111" });
    fx.balance(account, 100, { type: "OPBD" });
    fx.balance(account, 300, { type: "CLBD", referenceDate: "2026-11-08" });
    fx.balance(account, 350, { type: "CLBD", referenceDate: "2026-11-09" });
    fx.balance(account, 999, { type: "CLAV", referenceDate: "2026-11-09" });
    const found = listConnectionsView(queryDeps(t))
      .connections.flatMap((c) => c.accounts)
      .find((a) => a.id === account);
    expect(found?.balance).toMatchObject({ amountMinor: 350, type: "CLBD" });
  });

  it("reports sync and connection errors", () => {
    t.sqlite
      .prepare(
        "UPDATE accounts SET last_sync_error_code = 'ASPSP_TIMEOUT', last_sync_error_at = ?, rate_limited_until = ? WHERE id = ?",
      )
      .run(NOW - HOUR_MS, NOW + HOUR_MS, w.usd);
    t.sqlite
      .prepare(
        "UPDATE bank_connections SET status = 'error', last_error_code = 'ASPSP_ERROR', last_error_message = 'The bank is unreachable', last_error_at = ? WHERE id = ?",
      )
      .run(NOW - DAY_MS, w.bankB);
    const view = listConnectionsView(queryDeps(t));
    const bankB = view.connections.find((c) => c.id === w.bankB);
    expect(bankB).toMatchObject({
      status: "error",
      lastError: { code: "ASPSP_ERROR", message: "The bank is unreachable", at: NOW - DAY_MS },
    });
    expect(bankB?.accounts[0]).toMatchObject({
      lastSyncError: { code: "ASPSP_TIMEOUT", at: NOW - HOUR_MS },
      rateLimitedUntil: NOW + HOUR_MS,
    });
  });

  it("lists removed accounts apart, with their kept transaction count", () => {
    const view = listConnectionsView(queryDeps(t));
    expect(view.removedAccounts).toEqual([
      {
        id: w.removed,
        name: "Closed account",
        maskedIdentifier: "•••• 5555",
        bankName: "Old Bank",
        transactionCount: 1,
        removedAt: NOW - DAY_MS,
      },
    ]);
    const everyAccount = view.connections.flatMap((c) => c.accounts.map((a) => a.id));
    expect(everyAccount).not.toContain(w.removed);
  });

  it("names an account without nickname, product or details from its type and last digits", () => {
    const account = fx.account(w.bankA, { last4: "1234", cashAccountType: "CACC" });
    const found = listConnectionsView(queryDeps(t, { locale: () => "it" }))
      .connections.flatMap((c) => c.accounts)
      .find((a) => a.id === account);
    expect(found?.name).toBe(
      accountDisplayName(
        { nickname: null, product: null, details: null, cashAccountType: "CACC", last4: "1234" },
        "it",
      ),
    );
  });
});

describe("accountCurrency and getAccountDetail", () => {
  it("answers for every status and returns null for unknown ids", () => {
    const deps = queryDeps(t);
    expect(accountCurrency(deps, w.removed)).toBe("EUR");
    expect(accountCurrency(deps, w.disabled)).toBe("EUR");
    expect(accountCurrency(deps, w.usd)).toBe("USD");
    expect(accountCurrency(deps, 9_999)).toBeNull();
  });

  it("returns the account, its connection, the newest sync runs and the transaction count", () => {
    for (let hour = 0; hour < 25; hour += 1) {
      fx.repo.startSyncRun({
        accountId: w.checking,
        trigger: "background",
        startedAt: NOW - (hour + 1) * HOUR_MS,
        status: hour === 0 ? "failed" : "succeeded",
        finishedAt: NOW - (hour + 1) * HOUR_MS + 1_000,
      });
    }
    const detail = getAccountDetail(queryDeps(t), w.checking);
    expect(detail?.account).toMatchObject({ id: w.checking, name: "Conto Esempio" });
    expect(detail?.connection).toMatchObject({
      id: w.bankA,
      bankName: "Banca Esempio",
      status: "active",
    });
    expect(detail?.connection).not.toHaveProperty("accounts");
    expect(detail?.transactionCount).toBe(7);
    expect(detail?.syncRuns).toHaveLength(20);
    expect(detail?.syncRuns[0]).toMatchObject({
      status: "failed",
      trigger: "background",
      startedAt: NOW - HOUR_MS,
      finishedAt: NOW - HOUR_MS + 1_000,
      skipReason: null,
    });
    const starts = detail?.syncRuns.map((run) => run.startedAt) ?? [];
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
  });

  it("still returns a removed account and null for an unknown one", () => {
    const deps = queryDeps(t);
    expect(getAccountDetail(deps, w.removed)).toMatchObject({
      account: { status: "removed" },
      connection: { bankName: "Old Bank" },
      transactionCount: 1,
    });
    expect(getAccountDetail(deps, 9_999)).toBeNull();
  });
});

describe("balanceHistory", () => {
  it("walks back from the current balance undoing booked transactions", () => {
    const history = balanceHistory(queryDeps(t), w.checking, 30);
    expect(history?.currency).toBe("EUR");
    expect(history?.points).toHaveLength(30);
    expect(history?.points[0]?.date).toBe("2026-10-11");
    expect(history?.points.at(-1)?.date).toBe(TODAY);
    const at = (date: string) => history?.points.find((p) => p.date === date)?.balanceMinor;
    expect(at(TODAY)).toBe(500_000);
    expect(at("2026-11-08")).toBe(250_000); // before the 2 500,00 salary
    expect(at("2026-11-07")).toBe(251_250);
    expect(at("2026-11-06")).toBe(259_700);
    expect(at("2026-11-05")).toBe(259_700); // the pending coffee moves nothing
    expect(at("2026-10-15")).toBe(259_700);
    expect(at("2026-10-14")).toBe(271_700); // before the 120,00 rent
    expect(at("2026-10-11")).toBe(271_700);
  });

  it("supports the 90 and 365 day windows with consecutive days", () => {
    const deps = queryDeps(t);
    for (const days of [90, 365] as const) {
      const points = balanceHistory(deps, w.checking, days)?.points ?? [];
      expect(points).toHaveLength(days);
      expect(points.at(-1)?.date).toBe(TODAY);
    }
    const dates = (balanceHistory(deps, w.checking, 90)?.points ?? []).map((p) => p.date);
    expect(new Set(dates).size).toBe(90);
    expect([...dates].sort()).toEqual(dates);
  });

  it("is null without a balance or for an unknown account", () => {
    const deps = queryDeps(t);
    expect(balanceHistory(deps, w.disabled, 30)).toBeNull();
    expect(balanceHistory(deps, 9_999, 30)).toBeNull();
  });
});

describe("listTransactions", () => {
  it("counts only active and unavailable accounts by default", () => {
    const result = listTransactions(queryDeps(t), tq({ pageSize: "100" }));
    expect(result.total).toBe(10);
    expect(ids(result.items)).not.toContain(w.transactions.disabledShop);
    expect(ids(result.items)).not.toContain(w.transactions.removedShop);
    expect(result.facets).toEqual({ all: 10, in: 3, out: 7, pending: 1 });
    expect(result).toMatchObject({ page: 1, pageSize: 100 });
  });

  it("counts an unavailable account and drops it once disabled", () => {
    t.sqlite.prepare("UPDATE accounts SET status = 'unavailable' WHERE id = ?").run(w.usd);
    expect(listTransactions(queryDeps(t), tq()).total).toBe(10);
    t.sqlite.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").run(w.usd);
    expect(listTransactions(queryDeps(t), tq()).total).toBe(8);
  });

  it("lets an explicit account be disabled or removed", () => {
    const deps = queryDeps(t);
    expect(ids(listTransactions(deps, tq({ accountId: String(w.disabled) })).items)).toEqual([
      w.transactions.disabledShop,
    ]);
    const removed = listTransactions(deps, tq({ accountId: String(w.removed) }));
    expect(ids(removed.items)).toEqual([w.transactions.removedShop]);
    expect(removed.aggregate.totals.count).toBe(1);
    expect(listTransactions(deps, tq({ accountId: "9999" }))).toMatchObject({
      total: 0,
      items: [],
    });
  });

  it("maps each row with the account name, dates, amounts and description", () => {
    const result = listTransactions(queryDeps(t), tq({ accountId: String(w.checking) }));
    expect(result.items[0]).toEqual({
      id: w.transactions.salary,
      accountId: w.checking,
      accountName: "Conto Esempio",
      status: "booked",
      date: "2026-11-09",
      bookingDate: "2026-11-09",
      valueDate: "2026-11-09",
      amountMinor: 250_000,
      currency: "EUR",
      counterparty: "Acme Payroll",
      description: "Salary November",
    });
    const pending = result.items.find((item) => item.id === w.transactions.pendingCoffee);
    expect(pending).toMatchObject({ status: "pending", bookingDate: null });
  });

  it("filters by tab and keeps the facets", () => {
    const deps = queryDeps(t);
    const inflows = listTransactions(deps, tq({ tab: "in" }));
    expect(ids(inflows.items)).toEqual([
      w.transactions.salary,
      w.transactions.usdInvoice,
      w.transactions.saving,
    ]);
    expect(inflows.total).toBe(3);
    expect(inflows.facets).toEqual({ all: 10, in: 3, out: 7, pending: 1 });

    const outflows = listTransactions(deps, tq({ tab: "out" }));
    expect(outflows.total).toBe(7);
    expect(outflows.items.every((item) => item.amountMinor < 0)).toBe(true);

    const pending = listTransactions(deps, tq({ tab: "pending" }));
    expect(ids(pending.items)).toEqual([w.transactions.pendingCoffee]);
    expect(pending.total).toBe(1);
  });

  it("computes the facets with every other filter applied", () => {
    const deps = queryDeps(t);
    const coffee = listTransactions(deps, tq({ q: "coffee" }));
    expect(coffee.facets).toEqual({ all: 3, in: 0, out: 3, pending: 1 });
    const none = listTransactions(deps, tq({ q: "coffee", tab: "in" }));
    expect(none).toMatchObject({ total: 0, items: [] });
    expect(none.facets).toEqual({ all: 3, in: 0, out: 3, pending: 1 });

    const week = listTransactions(deps, tq({ from: "2026-11-07", to: "2026-11-09" }));
    expect(week.facets).toEqual({ all: 3, in: 1, out: 2, pending: 0 });

    const usd = listTransactions(deps, tq({ currency: "usd" }));
    expect(usd.facets).toEqual({ all: 2, in: 1, out: 1, pending: 0 });

    const account = listTransactions(deps, tq({ accountId: String(w.checking), tab: "pending" }));
    expect(account.facets).toEqual({ all: 7, in: 1, out: 6, pending: 1 });
  });

  it("builds the aggregate from every filter except the tab", () => {
    const deps = queryDeps(t);
    const all = listTransactions(deps, tq());
    expect(all.aggregate).toMatchObject({
      currency: "EUR",
      currencies: ["EUR", "USD"],
      from: "2026-10-10",
      to: TODAY,
      bucket: "day",
      totals: { inMinor: 260_000, outMinor: 24_150, netMinor: 235_850, count: 8 },
    });
    expect(all.aggregate.buckets).toHaveLength(31);

    const outTab = listTransactions(deps, tq({ tab: "out" }));
    expect(outTab.aggregate.totals).toEqual(all.aggregate.totals);
    const pendingTab = listTransactions(deps, tq({ tab: "pending" }));
    expect(pendingTab.aggregate.totals).toEqual(all.aggregate.totals);

    const searched = listTransactions(deps, tq({ q: "coffee", tab: "in" }));
    expect(searched.aggregate.totals).toEqual({
      inMinor: 0,
      outMinor: 2_500,
      netMinor: -2_500,
      count: 2,
    });
  });

  it("limits the aggregate to the period and the chosen currency", () => {
    const deps = queryDeps(t);
    const period = listTransactions(deps, tq({ from: "2026-11-07", to: "2026-11-09" })).aggregate;
    expect(period).toMatchObject({ from: "2026-11-07", to: TODAY, bucket: "day" });
    expect(period.buckets.map((b) => b.count)).toEqual([1, 1, 1]);

    const open = listTransactions(deps, tq({ from: "2026-11-08" })).aggregate;
    expect(open).toMatchObject({ from: "2026-11-08", to: TODAY });

    const usd = listTransactions(deps, tq({ currency: "USD" })).aggregate;
    expect(usd).toMatchObject({
      currency: "USD",
      currencies: ["EUR", "USD"],
      from: "2026-11-03",
      to: "2026-11-04",
      totals: { inMinor: 50_000, outMinor: 2_000, netMinor: 48_000, count: 2 },
    });
  });

  it("gives an empty aggregate for today when nothing matches", () => {
    const result = listTransactions(queryDeps(t), tq({ q: "nothing matches this" }));
    expect(result.total).toBe(0);
    expect(result.aggregate).toMatchObject({
      currency: "EUR",
      from: TODAY,
      to: TODAY,
      bucket: "day",
      totals: { inMinor: 0, outMinor: 0, netMinor: 0, count: 0 },
    });
    expect(result.aggregate.buckets).toHaveLength(1);
  });

  it("falls back to the first currency that matches when the default does not appear", () => {
    const result = listTransactions(queryDeps(t), tq({ q: "latte" }));
    expect(result.aggregate).toMatchObject({ currency: "USD", currencies: ["USD"] });
  });

  it("searches without regard to case or accents", () => {
    const deps = queryDeps(t);
    for (const q of ["caffe", "CAFFÈ", "caffè roma", "  Caffe  "]) {
      expect(ids(listTransactions(deps, tq({ q })).items), q).toEqual([
        w.transactions.coffee,
        w.transactions.pendingCoffee,
      ]);
    }
    expect(ids(listTransactions(deps, tq({ q: "monthly" })).items)).toEqual([
      w.transactions.saving,
    ]);
  });

  it("treats % and _ in the search as plain characters", () => {
    const deps = queryDeps(t);
    expect(ids(listTransactions(deps, tq({ q: "100%" })).items)).toEqual([w.transactions.rent]);
    expect(ids(listTransactions(deps, tq({ q: "%" })).items)).toEqual([w.transactions.rent]);
    expect(ids(listTransactions(deps, tq({ q: "paid_in" })).items)).toEqual([w.transactions.rent]);
    expect(listTransactions(deps, tq({ q: "paid%in" })).total).toBe(0);
  });

  it("matches amounts typed in either notation, ignoring the sign unless one is typed", () => {
    const deps = queryDeps(t);
    const coffees = [w.transactions.coffee, w.transactions.pendingCoffee];
    expect(ids(listTransactions(deps, tq({ q: "12,5" })).items)).toEqual(coffees);
    expect(ids(listTransactions(deps, tq({ q: "12.50" })).items)).toEqual(coffees);
    expect(ids(listTransactions(deps, tq({ q: "-12.50" })).items)).toEqual(coffees);
    expect(listTransactions(deps, tq({ q: "+12.50" })).total).toBe(0);
    expect(ids(listTransactions(deps, tq({ q: "2.500,00" })).items)).toEqual([
      w.transactions.salary,
    ]);
    expect(ids(listTransactions(deps, tq({ q: "2500" })).items)).toEqual([w.transactions.salary]);
    expect(ids(listTransactions(deps, tq({ q: "+2500" })).items)).toEqual([w.transactions.salary]);
    expect(listTransactions(deps, tq({ q: "-2500" })).total).toBe(0);
    expect(ids(listTransactions(deps, tq({ q: "84,5" })).items)).toEqual([
      w.transactions.groceries,
    ]);
    expect(listTransactions(deps, tq({ q: "12,345" })).total).toBe(0);
  });

  it("reads thousands separators and still finds text that looks like a number", () => {
    fx.transaction(w.checking, {
      sortDate: "2026-11-06",
      amountMinor: -123_456,
      counterparty: "Furniture Store",
    });
    const deps = queryDeps(t);
    expect(listTransactions(deps, tq({ q: "1.234,56" })).total).toBe(1);
    expect(listTransactions(deps, tq({ q: "1,234.56" })).total).toBe(1);
    // "12" is no amount in the database, but it is in "Invoice 12".
    expect(ids(listTransactions(deps, tq({ q: "12" })).items)).toEqual([w.transactions.usdInvoice]);
  });

  it("uses each currency's minor digits for amounts", () => {
    const yen = fx.account(w.bankA, { currency: "JPY", last4: "0001", product: "Yen account" });
    const row = fx.transaction(yen, {
      sortDate: "2026-11-02",
      amountMinor: -1_500,
      currency: "JPY",
      counterparty: "Tokyo Shop",
    });
    const result = listTransactions(queryDeps(t), tq({ q: "1500" }));
    expect(ids(result.items)).toEqual([row]);
    expect(listTransactions(queryDeps(t), tq({ q: "15" })).total).toBe(0);
  });

  it("sorts by date with the id as tie-breaker, in both directions", () => {
    const sameDayA = fx.transaction(w.checking, {
      sortDate: "2026-11-09",
      amountMinor: -1,
      counterparty: "Same day A",
    });
    const sameDayB = fx.transaction(w.checking, {
      sortDate: "2026-11-09",
      amountMinor: -2,
      counterparty: "Same day B",
    });
    const deps = queryDeps(t);
    const desc = ids(listTransactions(deps, tq({ pageSize: "100" })).items);
    expect(desc.slice(0, 3)).toEqual([sameDayB, sameDayA, w.transactions.salary]);
    const asc = ids(listTransactions(deps, tq({ order: "asc", pageSize: "100" })).items);
    expect(asc[0]).toBe(w.transactions.old);
    expect(asc.slice(-3)).toEqual([w.transactions.salary, sameDayA, sameDayB]);
  });

  it("sorts by amount", () => {
    const deps = queryDeps(t);
    const asc = listTransactions(deps, tq({ sort: "amount", order: "asc" })).items;
    expect(asc[0]?.id).toBe(w.transactions.rent);
    const desc = listTransactions(deps, tq({ sort: "amount", order: "desc" })).items;
    expect(desc[0]?.id).toBe(w.transactions.salary);
    expect(desc.map((item) => item.amountMinor)).toEqual(
      [...desc.map((item) => item.amountMinor)].sort((a, b) => b - a),
    );
  });

  it("sorts by counterparty ignoring case and accents, with unnamed rows last", () => {
    const unnamed = fx.transaction(w.checking, {
      sortDate: "2026-11-04",
      amountMinor: -3,
      remittance: "No name",
    });
    const deps = queryDeps(t);
    const names = (order: string) =>
      listTransactions(deps, tq({ sort: "counterparty", order, pageSize: "100" })).items.map(
        (item) => item.counterparty,
      );
    const asc = names("asc");
    expect(asc.slice(0, 6)).toEqual([
      "Acme Payroll",
      "Bakery Rossi",
      "Caffè Roma",
      "Caffè Roma",
      "Client Inc",
      "Coffee Corp",
    ]);
    expect(asc.at(-1)).toBeNull();
    const desc = names("desc");
    expect(desc[0]).toBe("Transfer in");
    expect(desc.at(-1)).toBeNull();
    expect(
      ids(listTransactions(deps, tq({ sort: "counterparty", pageSize: "100" })).items).at(-1),
    ).toBe(unnamed);
  });

  it("pages through the rows and returns an empty page beyond the last one", () => {
    for (let index = 0; index < 15; index += 1) {
      fx.transaction(w.checking, {
        sortDate: "2026-09-01",
        amountMinor: -(index + 1),
        counterparty: `Filler ${index}`,
      });
    }
    const deps = queryDeps(t);
    const first = listTransactions(deps, tq({ pageSize: "10" }));
    const second = listTransactions(deps, tq({ pageSize: "10", page: "2" }));
    const third = listTransactions(deps, tq({ pageSize: "10", page: "3" }));
    expect([first.items.length, second.items.length, third.items.length]).toEqual([10, 10, 5]);
    expect(new Set([...ids(first.items), ...ids(second.items), ...ids(third.items)]).size).toBe(25);
    expect(first.total).toBe(25);

    const beyond = listTransactions(deps, tq({ pageSize: "10", page: "9" }));
    expect(beyond).toMatchObject({ items: [], total: 25, page: 9, pageSize: 10 });
    expect(beyond.facets.all).toBe(25);
  });

  it("filters by an inclusive period", () => {
    const result = listTransactions(queryDeps(t), tq({ from: "2026-11-05", to: "2026-11-07" }));
    expect(ids(result.items)).toEqual([w.transactions.groceries, w.transactions.pendingCoffee]);
  });
});

describe("getTransaction", () => {
  it("returns the detail with the bank's remittance lines, code and balance", () => {
    const detail = getTransaction(queryDeps(t), w.transactions.salary ?? 0);
    expect(detail).toEqual({
      id: w.transactions.salary,
      accountId: w.checking,
      accountName: "Conto Esempio",
      status: "booked",
      date: "2026-11-09",
      bookingDate: "2026-11-09",
      valueDate: "2026-11-09",
      transactionDate: "2026-11-08",
      amountMinor: 250_000,
      currency: "EUR",
      counterparty: "Acme Payroll",
      description: "Salary November",
      providerReference: "REF-SALARY",
      counterpartyAccount: "DE89 •••• •••• 3000",
      remittanceLines: ["Salary November", "Rif. 2026/11"],
      bankCode: { code: "RCDT", subCode: "ESCT", description: "Credit transfer" },
      merchantCategoryCode: "5411",
      balanceAfter: { amountMinor: 500_000, currency: "EUR" },
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      bankName: "Banca Esempio",
    });
  });

  it("falls back to the stored text when the raw payload has no remittance lines", () => {
    const deps = queryDeps(t);
    expect(getTransaction(deps, w.transactions.coffee ?? 0)?.remittanceLines).toEqual(["Coffee"]);
    const bare = fx.transaction(w.checking, { sortDate: "2026-11-01", amountMinor: -1 });
    expect(getTransaction(deps, bare)).toMatchObject({
      remittanceLines: [],
      bankCode: null,
      balanceAfter: null,
    });
    const corrupt = fx.transaction(w.checking, {
      sortDate: "2026-11-01",
      amountMinor: -1,
      remittance: "Kept",
      rawJson: "{not json",
    });
    expect(getTransaction(deps, corrupt)?.remittanceLines).toEqual(["Kept"]);
  });

  it("opens rows of disabled and removed accounts and returns null for an unknown id", () => {
    const deps = queryDeps(t);
    expect(getTransaction(deps, w.transactions.disabledShop ?? 0)).toMatchObject({
      bankName: "Banca Esempio",
    });
    expect(getTransaction(deps, w.transactions.removedShop ?? 0)).toMatchObject({
      bankName: "Old Bank",
    });
    expect(getTransaction(deps, 99_999)).toBeNull();
  });
});

describe("cashflow", () => {
  it("covers the last 30 local days of the default currency with a running balance", () => {
    const result = cashflow(queryDeps(t), {});
    expect(result).toMatchObject({
      currency: "EUR",
      currencies: ["EUR", "USD"],
      from: "2026-10-11",
      to: TODAY,
      bucket: "day",
      totals: { inMinor: 260_000, outMinor: 23_450, netMinor: 236_550, count: 7 },
    });
    expect(result?.buckets).toHaveLength(30);
    const balance = (date: string) => result?.buckets.find((b) => b.date === date)?.balanceMinor;
    expect(balance(TODAY)).toBe(700_000); // 500 000 + 200 000
    expect(balance("2026-11-08")).toBe(450_000); // before the salary
    expect(balance("2026-11-07")).toBe(451_250);
    expect(balance("2026-11-01")).toBe(459_700); // 700 000 minus the 240 300 booked after it
    expect(balance("2026-10-11")).toBe(461_700); // before the saving transfer and the rent
  });

  it("supports one account, its own currency and a past period", () => {
    const deps = queryDeps(t);
    const usd = cashflow(deps, { accountId: w.usd });
    expect(usd).toMatchObject({
      currency: "USD",
      currencies: ["USD"],
      totals: { inMinor: 50_000, outMinor: 2_000, count: 2 },
    });
    const balance = (date: string) => usd?.buckets.find((b) => b.date === date)?.balanceMinor;
    expect(balance(TODAY)).toBe(80_000);
    expect(balance("2026-11-04")).toBe(80_000);
    expect(balance("2026-11-03")).toBe(30_000);
    expect(balance("2026-11-02")).toBe(32_000);

    const past = cashflow(deps, { from: "2026-11-01", to: "2026-11-04" });
    // 700 000 minus the booked flows dated after 11-04: +250 000 -1 250 -8 450.
    expect(past?.buckets.at(-1)?.balanceMinor).toBe(459_700);
    expect(past?.buckets).toHaveLength(4);
  });

  it("switches currency while keeping the other accounts out of it", () => {
    const usd = cashflow(queryDeps(t), { currency: "USD" });
    expect(usd).toMatchObject({ currency: "USD", currencies: ["EUR", "USD"] });
    expect(usd?.totals.count).toBe(2);
    expect(usd?.buckets.at(-1)?.balanceMinor).toBe(80_000);
  });

  it("allows an explicit disabled account and has no balance for it", () => {
    const result = cashflow(queryDeps(t), { accountId: w.disabled });
    expect(result?.totals.count).toBe(1);
    expect(result?.buckets.every((b) => b.balanceMinor === null)).toBe(true);
  });

  it("leaves the balance unknown when an account of the currency has none", () => {
    const account = fx.account(w.bankA, { last4: "2222" });
    fx.transaction(account, { sortDate: TODAY, amountMinor: -1 });
    const result = cashflow(queryDeps(t), {});
    expect(result?.buckets.every((b) => b.balanceMinor === null)).toBe(true);
  });

  it("answers null when there is nothing to draw", () => {
    const deps = queryDeps(t);
    expect(cashflow(deps, { accountId: 9_999 })).toBeNull();
    expect(cashflow(deps, { currency: "JPY" })).toBeNull();
    const empty = createTestDatabase();
    try {
      expect(cashflow(queryDeps(empty), {})).toBeNull();
      const other = new FinanceFixture(empty);
      const account = other.account(other.connection());
      expect(cashflow(queryDeps(empty), {})).toBeNull();
      expect(cashflow(queryDeps(empty), { accountId: account })).toBeNull();
    } finally {
      empty.dispose();
    }
  });

  it("does not fail for a period that starts in the future", () => {
    const result = cashflow(queryDeps(t), { from: "2026-12-01" });
    expect(result).toMatchObject({ from: "2026-12-01", to: "2026-12-01" });
    expect(result?.buckets).toHaveLength(1);
  });
});

describe("homeSummary", () => {
  it("sums the balances per currency without converting and skips excluded accounts", () => {
    fx.balance(w.disabled, 1_000_000);
    fx.balance(w.removed, 1_000_000);
    const summary = homeSummary(queryDeps(t), backupOk);
    expect(summary.generatedAt).toBe(NOW);
    expect(summary.balances).toEqual([
      { currency: "EUR", amountMinor: 700_000, accountCount: 2 },
      { currency: "USD", amountMinor: 80_000, accountCount: 1 },
    ]);
    expect(summary.accounts.map((a) => a.id)).toEqual([w.checking, w.savings, w.usd]);
    expect(summary.hasConnections).toBe(true);
    expect(summary.cashflow30d).toMatchObject({ currency: "EUR", bucket: "day" });
    expect(summary.cashflow30d?.buckets).toHaveLength(30);
  });

  it("uses the currency of the most included accounts for the 30-day flow", () => {
    fx.account(w.bankB, { currency: "USD", last4: "0002" });
    fx.account(w.bankB, { currency: "USD", last4: "0003" });
    expect(homeSummary(queryDeps(t), backupOk).cashflow30d?.currency).toBe("USD");
  });

  it("raises the consent and backup alerts", () => {
    const local = homeSummary(queryDeps(t), { target: "local", consecutiveFailures: 0 });
    expect(local.alerts).toEqual([
      { kind: "consent_expiring", connectionId: w.bankB, bankName: "Northwind Bank", days: 9 },
      { kind: "backup_local_only" },
    ]);
    expect(homeSummary(queryDeps(t), backupOk).alerts).toHaveLength(1);
    expect(homeSummary(queryDeps(t), { target: "s3", consecutiveFailures: 1 }).alerts).toHaveLength(
      1,
    );
    expect(
      homeSummary(queryDeps(t), { target: "s3", consecutiveFailures: 2 }).alerts.at(-1),
    ).toEqual({
      kind: "backup_failing",
      failures: 2,
    });
    expect(
      homeSummary(queryDeps(t), { target: "local", consecutiveFailures: 3 }).alerts.slice(-2),
    ).toEqual([{ kind: "backup_failing", failures: 3 }, { kind: "backup_local_only" }]);
  });

  it("raises expired and failed connection alerts first, and never for removed connections", () => {
    const expired = fx.connection({ aspspName: "Expired Bank", status: "expired" });
    const broken = fx.connection({ aspspName: "Broken Bank", status: "error" });
    const revoked = fx.connection({ aspspName: "Revoked Bank", status: "revoked" });
    const lapsed = fx.connection({ aspspName: "Lapsed Bank", validUntil: NOW - HOUR_MS });
    const alerts = homeSummary(queryDeps(t), backupOk).alerts;
    expect(alerts).toEqual([
      { kind: "consent_expired", connectionId: expired, bankName: "Expired Bank" },
      { kind: "connection_error", connectionId: broken, bankName: "Broken Bank" },
      { kind: "connection_error", connectionId: revoked, bankName: "Revoked Bank" },
      { kind: "consent_expired", connectionId: lapsed, bankName: "Lapsed Bank" },
      { kind: "consent_expiring", connectionId: w.bankB, bankName: "Northwind Bank", days: 9 },
    ]);
    expect(alerts.some((a) => "connectionId" in a && a.connectionId === w.removedBank)).toBe(false);
  });

  it("orders expiring consents by remaining days", () => {
    const soon = fx.connection({ aspspName: "Soon Bank", validUntil: NOW + 2 * DAY_MS });
    const later = fx.connection({ aspspName: "Later Bank", validUntil: NOW + 13 * DAY_MS });
    const kinds = homeSummary(queryDeps(t), backupOk).alerts.map((a) =>
      a.kind === "consent_expiring" ? [a.connectionId, a.days] : a.kind,
    );
    expect(kinds).toEqual([
      [soon, 2],
      [w.bankB, 9],
      [later, 13],
    ]);
  });

  it("raises sync_failing after 48 hours without success and a failed latest run", () => {
    const failedRun = (
      accountId: number,
      startedAt: number,
      status: "failed" | "succeeded" = "failed",
    ) =>
      fx.repo.startSyncRun({
        accountId,
        trigger: "background",
        startedAt,
        status,
        finishedAt: startedAt + 1_000,
      });
    const stale = fx.account(w.bankA, { product: "Stale", lastSyncedAt: NOW - 49 * HOUR_MS });
    failedRun(stale, NOW - HOUR_MS);
    const recent = fx.account(w.bankA, { product: "Recent", lastSyncedAt: NOW - 47 * HOUR_MS });
    failedRun(recent, NOW - HOUR_MS);
    const never = fx.account(w.bankA, { product: "Never", createdAt: NOW - 3 * DAY_MS });
    failedRun(never, NOW - HOUR_MS);
    const newborn = fx.account(w.bankA, { product: "Newborn", createdAt: NOW - 3 * HOUR_MS });
    failedRun(newborn, NOW - HOUR_MS);
    const recovered = fx.account(w.bankA, {
      product: "Recovered",
      lastSyncedAt: NOW - 49 * HOUR_MS,
    });
    failedRun(recovered, NOW - 2 * HOUR_MS);
    failedRun(recovered, NOW - HOUR_MS, "succeeded");
    const off = fx.account(w.bankA, {
      product: "Off",
      status: "disabled",
      lastSyncedAt: NOW - 49 * HOUR_MS,
    });
    failedRun(off, NOW - HOUR_MS);

    const alerts = homeSummary(queryDeps(t), backupOk).alerts.filter(
      (a) => a.kind === "sync_failing",
    );
    expect(alerts).toEqual([
      { kind: "sync_failing", accountId: stale, accountName: "Stale", since: NOW - 49 * HOUR_MS },
      { kind: "sync_failing", accountId: never, accountName: "Never", since: null },
    ]);
  });

  it("does not raise sync_failing for accounts of an unusable connection", () => {
    const expired = fx.connection({ aspspName: "Expired Bank", status: "expired" });
    const account = fx.account(expired, { lastSyncedAt: NOW - 49 * HOUR_MS });
    fx.repo.startSyncRun({
      accountId: account,
      trigger: "background",
      startedAt: NOW - HOUR_MS,
      status: "failed",
      finishedAt: NOW,
    });
    const kinds = homeSummary(queryDeps(t), backupOk).alerts.map((a) => a.kind);
    expect(kinds).not.toContain("sync_failing");
  });

  it("raises rate_limited only while the pause lasts", () => {
    const paused = fx.account(w.bankA, { product: "Paused", rateLimitedUntil: NOW + 3 * HOUR_MS });
    fx.account(w.bankA, { product: "Past pause", rateLimitedUntil: NOW - HOUR_MS });
    const alerts = homeSummary(queryDeps(t), backupOk).alerts.filter(
      (a) => a.kind === "rate_limited",
    );
    expect(alerts).toEqual([
      { kind: "rate_limited", accountId: paused, accountName: "Paused", until: NOW + 3 * HOUR_MS },
    ]);
  });

  it("reports an empty installation and ignores removed connections for hasConnections", () => {
    const empty = createTestDatabase();
    try {
      const summary = homeSummary(queryDeps(empty), { target: "local", consecutiveFailures: 0 });
      expect(summary).toMatchObject({
        balances: [],
        cashflow30d: null,
        accounts: [],
        hasConnections: false,
      });
      expect(summary.alerts).toEqual([{ kind: "backup_local_only" }]);
      const other = new FinanceFixture(empty);
      other.connection({ removedAt: NOW - DAY_MS });
      expect(homeSummary(queryDeps(empty), backupOk).hasConnections).toBe(false);
    } finally {
      empty.dispose();
    }
  });
});

describe("searchAll", () => {
  it("finds accounts by name, bank, last digits and IBAN, but not removed ones", () => {
    const deps = queryDeps(t);
    expect(searchAll(deps, "rainy").accounts).toEqual([
      { id: w.savings, name: "Rainy day", bankName: "Banca Esempio", last4: "9012" },
    ]);
    expect(searchAll(deps, "NORTHWIND").accounts.map((a) => a.id)).toEqual([w.usd]);
    expect(searchAll(deps, "3456").accounts.map((a) => a.id)).toEqual([w.checking]);
    expect(searchAll(deps, "it60x05").accounts.map((a) => a.id)).toEqual([w.checking]);
    expect(searchAll(deps, "old card").accounts.map((a) => a.id)).toEqual([w.disabled]);
    expect(searchAll(deps, "closed account").accounts).toEqual([]);
  });

  it("finds transactions of counted accounts, newest first", () => {
    const deps = queryDeps(t);
    expect(searchAll(deps, "Caffe").transactions).toEqual([
      {
        id: w.transactions.coffee,
        counterparty: "Caffè Roma",
        date: "2026-11-08",
        amountMinor: -1_250,
        currency: "EUR",
        accountName: "Conto Esempio",
      },
      {
        id: w.transactions.pendingCoffee,
        counterparty: "Caffè Roma",
        date: "2026-11-05",
        amountMinor: -1_250,
        currency: "EUR",
        accountName: "Conto Esempio",
      },
    ]);
    expect(searchAll(deps, "shop").transactions).toEqual([]);
    expect(searchAll(deps, "84,50").transactions.map((r) => r.id)).toEqual([
      w.transactions.groceries,
    ]);
  });

  it("returns at most six of each and names a counterparty-less row from its description", () => {
    for (let index = 0; index < 8; index += 1) {
      fx.transaction(w.checking, {
        sortDate: "2026-08-01",
        amountMinor: -1,
        counterparty: `Pizzeria ${index}`,
      });
      fx.account(w.bankA, { product: `Pizza card ${index}`, last4: `00${index}0` });
    }
    const deps = queryDeps(t);
    const result = searchAll(deps, "pizz");
    expect(result.transactions).toHaveLength(6);
    expect(result.accounts).toHaveLength(6);

    fx.transaction(w.checking, {
      sortDate: "2026-11-09",
      amountMinor: -5,
      remittance: "Bonifico per cena",
    });
    expect(searchAll(deps, "cena").transactions[0]?.counterparty).toBe("Bonifico per cena");
  });
});

describe("updateAccount", () => {
  const auditRows = () =>
    t.sqlite.prepare("SELECT actor, action, target, details FROM audit_log ORDER BY id").all() as {
      actor: string;
      action: string;
      target: string | null;
      details: string | null;
    }[];

  it("renames an account and audits it without the nickname", () => {
    const deps = { ...queryDeps(t), audit: new AuditLog(t.db, () => NOW) };
    const updated = updateAccount(deps, w.checking, { nickname: "Salary account" });
    expect(updated).toMatchObject({
      id: w.checking,
      nickname: "Salary account",
      name: "Salary account",
    });
    const rows = auditRows();
    expect(rows).toEqual([
      {
        actor: "user",
        action: "account.rename",
        target: `account:${w.checking}`,
        details: '{"cleared":false}',
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("Salary account");
  });

  it("clears a nickname and records that it was cleared", () => {
    const deps = { ...queryDeps(t), audit: new AuditLog(t.db, () => NOW) };
    const updated = updateAccount(deps, w.savings, { nickname: null });
    expect(updated).toMatchObject({ nickname: null });
    expect(auditRows()[0]).toMatchObject({ action: "account.rename", details: '{"cleared":true}' });
  });

  it("disables and re-enables an account", () => {
    const deps = { ...queryDeps(t), audit: new AuditLog(t.db, () => NOW) };
    expect(updateAccount(deps, w.checking, { status: "disabled" })).toMatchObject({
      status: "disabled",
    });
    expect(listTransactions(deps, tq()).total).toBe(3);
    expect(updateAccount(deps, w.checking, { status: "active" })).toMatchObject({
      status: "active",
    });
    expect(listTransactions(deps, tq()).total).toBe(10);
    expect(auditRows().map((r) => r.action)).toEqual(["account.disable", "account.enable"]);
  });

  it("enables an account of a connection that needs renewal", () => {
    t.sqlite.prepare("UPDATE bank_connections SET status = 'expired' WHERE id = ?").run(w.bankA);
    const deps = { ...queryDeps(t), audit: new AuditLog(t.db, () => NOW) };
    expect(updateAccount(deps, w.disabled, { status: "active" })).toMatchObject({
      status: "active",
    });
  });

  it("puts an unavailable account back to active when the owner enables it", () => {
    t.sqlite.prepare("UPDATE accounts SET status = 'unavailable' WHERE id = ?").run(w.savings);
    const deps = { ...queryDeps(t), audit: new AuditLog(t.db, () => NOW) };
    expect(updateAccount(deps, w.savings, { status: "active" })).toMatchObject({
      status: "active",
    });
  });

  it("does nothing, and audits nothing, for an empty or unchanged patch", () => {
    const deps = { ...queryDeps(t), audit: new AuditLog(t.db, () => NOW) };
    const before = t.sqlite.prepare("SELECT updated_at FROM accounts WHERE id = ?").get(w.checking);
    expect(updateAccount(deps, w.checking, {})).toMatchObject({ id: w.checking });
    expect(updateAccount(deps, w.checking, { status: "active" })).toMatchObject({ id: w.checking });
    expect(updateAccount(deps, w.checking, { nickname: null })).toMatchObject({ id: w.checking });
    expect(auditRows()).toEqual([]);
    expect(
      t.sqlite.prepare("SELECT updated_at FROM accounts WHERE id = ?").get(w.checking),
    ).toEqual(before);
  });

  it("refuses a removed account and returns null for an unknown one", () => {
    const deps = { ...queryDeps(t), audit: new AuditLog(t.db, () => NOW) };
    expect(updateAccount(deps, w.removed, { nickname: "Revived" })).toBe("not_allowed");
    expect(updateAccount(deps, 9_999, { nickname: "Ghost" })).toBeNull();
    expect(auditRows()).toEqual([]);
    expect(t.sqlite.prepare("SELECT nickname FROM accounts WHERE id = ?").get(w.removed)).toEqual({
      nickname: null,
    });
  });
});

describe("the transaction list on 10 000 rows", () => {
  beforeEach(() => {
    const insert = t.sqlite.prepare(
      `INSERT INTO transactions (account_id, fingerprint, status, booking_date, sort_date, amount_minor, currency,
         counterparty, remittance, search_text, raw_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, '{}', ?, ?)`,
    );
    const accountIds = [w.checking, w.savings];
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    t.sqlite.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const day = new Date(Date.UTC(2024, 0, 1) + next(1_000) * DAY_MS)
          .toISOString()
          .slice(0, 10);
        const pending = index % 50 === 0;
        const name = `Merchant ${next(300)}`;
        insert.run(
          accountIds[index % 3 === 0 ? 1 : 0],
          `bulk-${index}`,
          pending ? "pending" : "booked",
          pending ? null : day,
          day,
          (next(2) === 0 ? 1 : -1) * (100 + next(50_000)),
          name,
          `Payment ${index}`,
          `${name} payment ${index}`.toLowerCase(),
          NOW,
          NOW,
        );
      }
    })();
    t.sqlite.exec("ANALYZE");
  });

  it("answers the first page, facets and aggregate well under a second", () => {
    const deps = queryDeps(t);
    const started = performance.now();
    const result = listTransactions(deps, tq());
    const elapsed = performance.now() - started;
    console.info(`listTransactions on 10 000 rows: ${elapsed.toFixed(1)} ms`);
    expect(result.total).toBeGreaterThan(9_000);
    expect(result.items).toHaveLength(20);
    expect(result.facets.all).toBe(result.total);
    expect(result.aggregate.totals.count).toBeGreaterThan(9_000);
    expect(elapsed).toBeLessThan(1_000);

    const searchStarted = performance.now();
    const searched = listTransactions(
      deps,
      tq({ q: "merchant 7", tab: "out", sort: "counterparty" }),
    );
    const searchElapsed = performance.now() - searchStarted;
    console.info(
      `filtered, sorted listTransactions on 10 000 rows: ${searchElapsed.toFixed(1)} ms`,
    );
    expect(searched.total).toBeGreaterThan(0);
    expect(searchElapsed).toBeLessThan(1_000);
  });

  it("keeps the other read APIs fast", () => {
    const deps = queryDeps(t);
    const started = performance.now();
    homeSummary(deps, backupOk);
    listConnectionsView(deps);
    balanceHistory(deps, w.checking, 365);
    cashflow(deps, { from: "2024-01-01", to: TODAY });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("reads the date index instead of sorting", () => {
    const deps = queryDeps(t);
    const plan = (query: Record<string, string>) => {
      const { sql, params } = buildTransactionListSql(deps, tq(query));
      return (t.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map((row) => row.detail)
        .join("\n");
    };
    const everything = plan({});
    expect(everything).toMatch(/transactions_date_idx/);
    expect(everything).not.toMatch(/TEMP B-TREE/);
    const oneAccount = plan({ accountId: String(w.checking) });
    expect(oneAccount).toMatch(/transactions_account_date_idx/);
    expect(oneAccount).not.toMatch(/TEMP B-TREE/);
  });
});
