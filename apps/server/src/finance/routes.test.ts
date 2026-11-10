import type {
  AccountDetailResponse,
  AccountSummary,
  BalanceHistoryResponse,
  CashFlowResponse,
  ConnectionsResponse,
  HomeSummary,
  SearchResponse,
  TransactionDetail,
  TransactionListResponse,
} from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../audit";
import { loadConfig } from "../config";
import { seedBanking } from "../qa/seed-banking";
import type { SeedContext } from "../server";
import { createTestApp, type TestApp } from "../test/app";
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from "../test/db";
import {
  buildWorld,
  FinanceFixture,
  NOW,
  queryDeps,
  TIME_ZONE,
  TODAY,
  type World,
} from "../test/finance";
import { financeRoutes } from "./routes";

let t: TestDatabase;
let fx: FinanceFixture;
let w: World;
let ta: TestApp;
let clock = NOW;
let backup: { target: "local" | "s3"; consecutiveFailures: number };

async function mount(): Promise<TestApp> {
  return createTestApp({
    database: t,
    now: () => clock,
    routers: [
      {
        prefix: "/api",
        router: financeRoutes({
          ...queryDeps(t, { now: () => clock }),
          audit: new AuditLog(t.db, () => clock),
          backup: () => backup,
        }),
      },
    ],
  });
}

beforeEach(async () => {
  t = createTestDatabase();
  fx = new FinanceFixture(t);
  w = buildWorld(fx);
  clock = NOW;
  backup = { target: "s3", consecutiveFailures: 0 };
  ta = await mount();
});
afterEach(() => t.dispose());

const auditActions = () =>
  (t.sqlite.prepare("SELECT action FROM audit_log ORDER BY id").all() as { action: string }[]).map(
    (row) => row.action,
  );

describe("authentication", () => {
  it.each([
    "/api/connections",
    "/api/accounts/1",
    "/api/accounts/1/balance-history",
    "/api/transactions",
    "/api/transactions/1",
    "/api/cashflow",
    "/api/summary",
    "/api/search?q=caffe",
  ])("rejects an anonymous GET %s", async (path) => {
    const response = await ta.app.request(path);
    expect(response.status).toBe(401);
  });

  it("rejects an anonymous PATCH", async () => {
    const response = await ta.app.request("/api/accounts/1", {
      method: "PATCH",
      headers: { origin: ta.origin, "content-type": "application/json" },
      body: JSON.stringify({ nickname: "x" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("GET /api/connections", () => {
  it("lists live connections, their accounts and the removed accounts", async () => {
    const { status, body } = await ta.json("/api/connections");
    const view = body as ConnectionsResponse;
    expect(status).toBe(200);
    expect(view.connections.map((c) => c.bankName)).toEqual(["Banca Esempio", "Northwind Bank"]);
    expect(view.connections[1]?.status).toBe("expiring");
    expect(view.removedAccounts.map((a) => a.id)).toEqual([w.removed]);
  });

  it("flags the accounts that have a sync queued or running", async () => {
    const deps = queryDeps(t);
    deps.queue.enqueueUnique("bank.sync-account", `sync:${w.checking}`, {
      accountId: w.checking,
      trigger: "manual",
    });
    const view = (await ta.json("/api/connections")).body as ConnectionsResponse;
    const flags = view.connections.flatMap((c) => c.accounts.map((a) => [a.id, a.syncInProgress]));
    expect(flags).toContainEqual([w.checking, true]);
    expect(flags).toContainEqual([w.savings, false]);
  });
});

describe("GET /api/accounts/:accountId", () => {
  it("returns the account detail", async () => {
    const { status, body } = await ta.json(`/api/accounts/${w.checking}`);
    const detail = body as AccountDetailResponse;
    expect(status).toBe(200);
    expect(detail.account.name).toBe("Conto Esempio");
    expect(detail.transactionCount).toBe(7);
    expect(detail.connection.bankName).toBe("Banca Esempio");
  });

  it("still returns a removed account", async () => {
    const { status, body } = await ta.json(`/api/accounts/${w.removed}`);
    expect(status).toBe(200);
    expect((body as AccountDetailResponse).account.status).toBe("removed");
  });

  it.each(["9999", "abc", "0", "-1", "1e3", "01", "1.5"])(
    "answers 404 not_found for %s",
    async (id) => {
      const { status, body } = await ta.json(`/api/accounts/${id}`);
      expect(status).toBe(404);
      expect(body).toEqual({ error: "Not found", code: "not_found" });
    },
  );

  it("answers 404 once the account has been purged", async () => {
    t.sqlite.prepare("DELETE FROM accounts WHERE id = ?").run(w.removed);
    expect((await ta.json(`/api/accounts/${w.removed}`)).status).toBe(404);
    expect((await ta.json(`/api/transactions/${w.transactions.removedShop}`)).status).toBe(404);
    const view = (await ta.json("/api/connections")).body as ConnectionsResponse;
    expect(view.removedAccounts).toEqual([]);
  });
});

describe("PATCH /api/accounts/:accountId", () => {
  const patch = (id: number | string, body: unknown) =>
    ta.json(`/api/accounts/${id}`, { method: "PATCH", body });

  it("renames an account and audits it without the nickname", async () => {
    const { status, body } = await patch(w.checking, { nickname: "  Daily spending  " });
    expect(status).toBe(200);
    expect(body as AccountSummary).toMatchObject({
      id: w.checking,
      nickname: "Daily spending",
      name: "Daily spending",
    });
    expect(auditActions()).toEqual(["account.rename"]);
    const rows = t.sqlite.prepare("SELECT * FROM audit_log").all();
    expect(JSON.stringify(rows)).not.toContain("Daily spending");
    expect((await ta.json(`/api/accounts/${w.checking}`)).body).toMatchObject({
      account: { nickname: "Daily spending" },
    });
  });

  it("clears a nickname with an empty string", async () => {
    const { body } = await patch(w.savings, { nickname: "" });
    expect(body as AccountSummary).toMatchObject({ nickname: null });
  });

  it("disables and re-enables an account, which leaves and re-enters the totals", async () => {
    expect((await patch(w.usd, { status: "disabled" })).body).toMatchObject({ status: "disabled" });
    const summary = (await ta.json("/api/summary")).body as HomeSummary;
    expect(summary.balances.map((b) => b.currency)).toEqual(["EUR"]);
    expect((await patch(w.usd, { status: "active" })).body).toMatchObject({ status: "active" });
    expect(auditActions()).toEqual(["account.disable", "account.enable"]);
  });

  it("allows enabling an account whose connection needs renewal", async () => {
    t.sqlite.prepare("UPDATE bank_connections SET status = 'expired' WHERE id = ?").run(w.bankA);
    const { status, body } = await patch(w.disabled, { status: "active" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "active" });
  });

  it("refuses to change a removed account", async () => {
    const { status, body } = await patch(w.removed, { nickname: "Revived" });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "not_allowed" });
    expect(auditActions()).toEqual([]);
  });

  it("answers 404 for an unknown account", async () => {
    expect((await patch(9_999, { nickname: "Ghost" })).status).toBe(404);
    expect((await patch("abc", { nickname: "Ghost" })).status).toBe(404);
  });

  it.each([
    ["an unknown key", { currency: "USD" }],
    ["a long nickname", { nickname: "x".repeat(81) }],
    ["a status the owner cannot set", { status: "removed" }],
    ["a non-string nickname", { nickname: 5 }],
    ["a non-object body", "nickname"],
    ["a null body", null],
  ])("rejects %s", async (_name, body) => {
    const { status, body: error } = await patch(w.checking, body);
    expect(status).toBe(400);
    expect(error).toMatchObject({ code: "invalid_body" });
    expect(auditActions()).toEqual([]);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await ta.app.request(`/api/accounts/${w.checking}`, {
      method: "PATCH",
      headers: { origin: ta.origin, "content-type": "application/json", cookie: ta.cookie },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("keeps the Origin check of the application", async () => {
    const response = await ta.app.request(`/api/accounts/${w.checking}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: ta.cookie,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ nickname: "x" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("GET /api/accounts/:accountId/balance-history", () => {
  it("defaults to 90 daily points ending today", async () => {
    const { status, body } = await ta.json(`/api/accounts/${w.checking}/balance-history`);
    const history = body as BalanceHistoryResponse;
    expect(status).toBe(200);
    expect(history.currency).toBe("EUR");
    expect(history.points).toHaveLength(90);
    expect(history.points.at(-1)).toEqual({ date: TODAY, balanceMinor: 500_000 });
  });

  it("accepts 30, 90 and 365 days and rejects other windows", async () => {
    for (const days of [30, 365]) {
      const { body } = await ta.json(`/api/accounts/${w.checking}/balance-history?days=${days}`);
      expect((body as BalanceHistoryResponse).points).toHaveLength(days);
    }
    const bad = await ta.json(`/api/accounts/${w.checking}/balance-history?days=7`);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "invalid_query" });
  });

  it("returns an empty series for an account without a balance and 404 for an unknown one", async () => {
    const empty = await ta.json(`/api/accounts/${w.disabled}/balance-history`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ currency: "EUR", points: [] });
    expect((await ta.json("/api/accounts/9999/balance-history")).status).toBe(404);
  });
});

describe("GET /api/transactions", () => {
  it("returns the first page with facets and the aggregate", async () => {
    const { status, body } = await ta.json("/api/transactions");
    const list = body as TransactionListResponse;
    expect(status).toBe(200);
    expect(list).toMatchObject({ total: 10, page: 1, pageSize: 20 });
    expect(list.items).toHaveLength(10);
    expect(list.facets).toEqual({ all: 10, in: 3, out: 7, pending: 1 });
    expect(list.aggregate.currency).toBe("EUR");
  });

  it("applies the query string", async () => {
    const { body } = await ta.json(
      `/api/transactions?q=caff%C3%A8&tab=out&sort=amount&order=asc&pageSize=10&from=2026-11-01&to=2026-11-30&currency=eur&accountId=${w.checking}`,
    );
    const list = body as TransactionListResponse;
    expect(list.items.map((i) => i.id)).toEqual([
      w.transactions.coffee,
      w.transactions.pendingCoffee,
    ]);
    expect(list).toMatchObject({ total: 2, pageSize: 10 });
  });

  it("finds a payment by its amount", async () => {
    const list = (await ta.json("/api/transactions?q=84,50")).body as TransactionListResponse;
    expect(list.items.map((i) => i.id)).toEqual([w.transactions.groceries]);
  });

  it("returns an empty page, with the real total, beyond the last page", async () => {
    const list = (await ta.json("/api/transactions?pageSize=10&page=5"))
      .body as TransactionListResponse;
    expect(list.items).toEqual([]);
    expect(list.total).toBe(10);
  });

  it.each([
    "page=0",
    "pageSize=15",
    "tab=refunds",
    "sort=category",
    "order=up",
    "from=2026-13-01",
    "from=2026-11-10&to=2026-11-01",
    "accountId=abc",
    "currency=EURO",
    `q=${"x".repeat(101)}`,
  ])("answers 400 invalid_query for %s", async (query) => {
    const { status, body } = await ta.json(`/api/transactions?${query}`);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "Invalid query", code: "invalid_query" });
  });
});

describe("GET /api/transactions/:transactionId", () => {
  it("returns the detail", async () => {
    const { status, body } = await ta.json(`/api/transactions/${w.transactions.salary}`);
    const detail = body as TransactionDetail;
    expect(status).toBe(200);
    expect(detail).toMatchObject({
      counterparty: "Acme Payroll",
      remittanceLines: ["Salary November", "Rif. 2026/11"],
      bankName: "Banca Esempio",
      providerReference: "REF-SALARY",
    });
  });

  it("opens a row of a removed account and answers 404 for an unknown or malformed id", async () => {
    expect((await ta.json(`/api/transactions/${w.transactions.removedShop}`)).status).toBe(200);
    expect((await ta.json("/api/transactions/99999")).status).toBe(404);
    expect((await ta.json("/api/transactions/abc")).status).toBe(404);
  });
});

describe("GET /api/cashflow", () => {
  it("returns the last 30 days with a running balance", async () => {
    const { status, body } = await ta.json("/api/cashflow");
    const flow = body as CashFlowResponse;
    expect(status).toBe(200);
    expect(flow).toMatchObject({ currency: "EUR", from: "2026-10-11", to: TODAY, bucket: "day" });
    expect(flow.buckets.at(-1)?.balanceMinor).toBe(700_000);
  });

  it("filters by account, currency and period", async () => {
    const usd = (await ta.json(`/api/cashflow?accountId=${w.usd}`)).body as CashFlowResponse;
    expect(usd).toMatchObject({ currency: "USD", currencies: ["USD"] });
    const eur = (await ta.json("/api/cashflow?currency=EUR&from=2026-11-01&to=2026-11-09"))
      .body as CashFlowResponse;
    expect(eur.buckets).toHaveLength(9);
  });

  it("answers 204 with no body when there is nothing to draw", async () => {
    const account = fx.account(w.bankA, { last4: "9999" });
    const response = await ta.app.request(`/api/cashflow?accountId=${account}`, {
      headers: { cookie: ta.cookie },
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect((await ta.json("/api/cashflow?accountId=9999")).status).toBe(204);
  });

  it("answers 400 invalid_query for a bad query", async () => {
    expect((await ta.json("/api/cashflow?from=2026-11-10&to=2026-11-01")).status).toBe(400);
    expect((await ta.json("/api/cashflow?accountId=-3")).status).toBe(400);
  });
});

describe("GET /api/summary", () => {
  it("returns balances per currency, the 30-day flow, accounts and alerts", async () => {
    const { status, body } = await ta.json("/api/summary");
    const summary = body as HomeSummary;
    expect(status).toBe(200);
    expect(summary.balances).toEqual([
      { currency: "EUR", amountMinor: 700_000, accountCount: 2 },
      { currency: "USD", amountMinor: 80_000, accountCount: 1 },
    ]);
    expect(summary.cashflow30d?.currency).toBe("EUR");
    expect(summary.accounts).toHaveLength(3);
    expect(summary.alerts.map((a) => a.kind)).toEqual(["consent_expiring"]);
    expect(summary.hasConnections).toBe(true);
  });

  it("reads the backup state on every request", async () => {
    backup = { target: "local", consecutiveFailures: 2 };
    const kinds = ((await ta.json("/api/summary")).body as HomeSummary).alerts.map((a) => a.kind);
    expect(kinds).toEqual(["consent_expiring", "backup_failing", "backup_local_only"]);
  });
});

describe("GET /api/search", () => {
  it("returns matching accounts and transactions", async () => {
    const { status, body } = await ta.json("/api/search?q=caffe");
    const result = body as SearchResponse;
    expect(status).toBe(200);
    expect(result.transactions.map((r) => r.id)).toEqual([
      w.transactions.coffee,
      w.transactions.pendingCoffee,
    ]);
    expect(result.accounts).toEqual([]);
    const byBank = (await ta.json("/api/search?q=northwind")).body as SearchResponse;
    expect(byBank.accounts.map((a) => a.id)).toEqual([w.usd]);
  });

  it("answers 400 invalid_query for a query that is too short or missing", async () => {
    expect((await ta.json("/api/search?q=a")).status).toBe(400);
    expect((await ta.json("/api/search")).status).toBe(400);
    expect((await ta.json(`/api/search?q=${"x".repeat(101)}`)).status).toBe(400);
  });
});

describe("with the QA seed", () => {
  beforeEach(async () => {
    t.dispose();
    t = createTestDatabase();
    const config = loadConfig({
      BURSAR_PUBLIC_URL: "https://bursar.example.test",
      TZ: TIME_ZONE,
      BURSAR_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
      BURSAR_DATA_DIR: t.dir,
      BURSAR_MIGRATIONS_DIR: MIGRATIONS_DIR,
    });
    const context: SeedContext = { db: t.db, sqlite: t.sqlite, config, now: () => NOW };
    seedBanking(context);
    ta = await mount();
  });

  it("answers every route with the data the panel pages are built on", async () => {
    const connections = (await ta.json("/api/connections")).body as ConnectionsResponse;
    expect(connections.connections).toHaveLength(5);
    expect(connections.removedAccounts).toHaveLength(1);
    expect(connections.connections.flatMap((c) => c.accounts).map((a) => a.status)).toEqual(
      expect.arrayContaining(["active", "disabled", "unavailable"]),
    );

    const summary = (await ta.json("/api/summary")).body as HomeSummary;
    expect(summary.balances.map((b) => b.currency).sort()).toEqual(["EUR", "USD"]);
    expect(summary.accounts).toHaveLength(8);
    const kinds = new Set(summary.alerts.map((a) => a.kind));
    for (const kind of [
      "consent_expiring",
      "consent_expired",
      "connection_error",
      "rate_limited",
    ]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(summary.cashflow30d?.buckets).toHaveLength(30);

    const list = (await ta.json("/api/transactions?pageSize=100")).body as TransactionListResponse;
    expect(list.total).toBeGreaterThan(100);
    expect(list.items).toHaveLength(100);
    expect(list.facets.all).toBe(list.total);
    expect(list.facets.pending).toBeGreaterThan(0);

    const detail = (await ta.json("/api/accounts/1")).body as AccountDetailResponse;
    expect(detail.syncRuns.length).toBeGreaterThan(0);
    expect((await ta.json("/api/accounts/1/balance-history?days=30")).status).toBe(200);
    expect((await ta.json("/api/cashflow?accountId=1")).status).toBe(200);
    expect((await ta.json("/api/accounts/10")).body).toMatchObject({
      account: { status: "removed" },
    });
    const removed = (await ta.json("/api/transactions?accountId=10"))
      .body as TransactionListResponse;
    expect(removed.total).toBeGreaterThan(0);
    const first = list.items[0];
    expect((await ta.json(`/api/transactions/${first?.id}`)).status).toBe(200);
    expect((await ta.json("/api/search?q=an")).status).toBe(200);
  });
});

describe("the time zone", () => {
  it("decides which local day a request is about", async () => {
    // 23:30 in Rome on 2026-11-09 is 22:30 UTC; an hour later it is already the 10th in Rome.
    clock = Date.UTC(2026, 10, 9, 23, 30, 0);
    const flow = (await ta.json("/api/cashflow")).body as CashFlowResponse;
    expect(flow).toMatchObject({ from: "2026-10-12", to: "2026-11-10" });
  });
});
