import {
  type AccountDetailResponse,
  type AccountSummary,
  type CashFlowResponse,
  SETTINGS_DEFAULTS,
  type SyncRunItem,
  type TransactionListResponse,
} from "@bursar/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/ui";
import i18n from "../i18n";
import { FormatProvider } from "../lib/format";
import { renderRoutes } from "../test/router";
import { AccountDetailPage } from "./AccountDetailPage";

vi.mock("../components/charts/BalanceChart", () => ({
  BalanceChart: (props: { points: unknown[]; currency: string; summaryLabel: string }) => (
    <div
      data-testid="balance-chart"
      data-points={props.points.length}
      data-currency={props.currency}
    >
      {props.summaryLabel}
    </div>
  ),
}));
vi.mock("../components/charts/CashFlowStrip", () => ({
  CashFlowStrip: (props: {
    buckets: unknown[];
    variant: string;
    showBalance?: boolean;
    highlightNegativeNet: boolean;
  }) => (
    <div
      data-testid="cashflow-strip"
      data-variant={props.variant}
      data-show-balance={String(props.showBalance)}
      data-highlight={String(props.highlightNegativeNet)}
      data-buckets={props.buckets.length}
    />
  ),
}));
vi.mock("./accounts/DisconnectDialog", () => ({
  DisconnectDialog: (props: { connection: { id: number; bankName: string } | null }) =>
    props.connection ? (
      <div role="dialog" aria-label={`Disconnect ${props.connection.bankName}?`} />
    ) : null,
}));

const NOW = Date.parse("2026-11-09T09:00:00Z"); // 10:00 on 9 Nov in Europe/Rome
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ACCOUNT: AccountSummary = {
  id: 1,
  connectionId: 3,
  name: "Conto Smart",
  nickname: null,
  bankProduct: "Conto Smart",
  maskedIdentifier: "IT95 •••• •••• 0001",
  iban: "IT95X9999999999000000010001",
  last4: "0001",
  currency: "EUR",
  cashAccountType: "CACC",
  status: "active",
  balance: { amountMinor: 420_000, currency: "EUR", type: "ITBD", asOf: NOW - 2 * HOUR },
  net30d: { inMinor: 300_000, outMinor: 200_000, netMinor: 100_000 },
  daily30d: [],
  lastSyncedAt: NOW - 2 * HOUR,
  lastSyncError: null,
  rateLimitedUntil: null,
  syncInProgress: false,
};

const CONNECTION: AccountDetailResponse["connection"] = {
  id: 3,
  bankName: "Banca Esempio",
  country: "IT",
  hasLogo: false,
  status: "active",
  validUntil: NOW + 88 * DAY,
  createdAt: NOW - 125 * DAY,
  renewedAt: null,
  lastError: null,
};

const RUNS: SyncRunItem[] = [
  {
    id: 30,
    trigger: "manual",
    status: "succeeded",
    startedAt: NOW - 2 * HOUR,
    finishedAt: NOW - 2 * HOUR + 4_000,
    inserted: 3,
    updated: 1,
    removed: 0,
    errorCode: null,
    skipReason: null,
  },
  {
    id: 29,
    trigger: "background",
    status: "failed",
    startedAt: NOW - 26 * HOUR,
    finishedAt: NOW - 26 * HOUR + 2_000,
    inserted: 0,
    updated: 0,
    removed: 0,
    errorCode: "EXPIRED_SESSION",
    skipReason: null,
  },
  {
    id: 28,
    trigger: "background",
    status: "skipped",
    startedAt: NOW - 50 * HOUR,
    finishedAt: NOW - 50 * HOUR,
    inserted: 0,
    updated: 0,
    removed: 0,
    errorCode: null,
    skipReason: "rate_limited",
  },
];

function makeDetail(
  patch: {
    account?: Partial<AccountSummary>;
    connection?: Partial<AccountDetailResponse["connection"]>;
    syncRuns?: SyncRunItem[];
  } = {},
): AccountDetailResponse {
  return {
    account: { ...ACCOUNT, ...patch.account },
    connection: { ...CONNECTION, ...patch.connection },
    syncRuns: patch.syncRuns ?? RUNS,
    transactionCount: 57,
  };
}

const TRANSACTIONS: TransactionListResponse = {
  items: [
    {
      id: 501,
      accountId: 1,
      accountName: "Conto Smart",
      status: "booked",
      date: "2026-11-08",
      bookingDate: "2026-11-08",
      valueDate: "2026-11-08",
      amountMinor: -4_250,
      currency: "EUR",
      counterparty: "Mercato Verde",
      description: "Groceries",
    },
    {
      id: 500,
      accountId: 1,
      accountName: "Conto Smart",
      status: "pending",
      date: "2026-11-09",
      bookingDate: null,
      valueDate: null,
      amountMinor: -1_200,
      currency: "EUR",
      counterparty: "Caffe Centrale",
      description: null,
    },
    {
      id: 499,
      accountId: 1,
      accountName: "Conto Smart",
      status: "booked",
      date: "2026-11-05",
      bookingDate: "2026-11-05",
      valueDate: "2026-11-05",
      amountMinor: 245_000,
      currency: "EUR",
      counterparty: "Employer Srl",
      description: "Salary November",
    },
  ],
  total: 57,
  page: 1,
  pageSize: 20,
  facets: { all: 57, in: 4, out: 53, pending: 1 },
  aggregate: {} as CashFlowResponse,
};

const CASHFLOW: CashFlowResponse = {
  currency: "EUR",
  currencies: ["EUR"],
  from: "2026-10-11",
  to: "2026-11-09",
  bucket: "day",
  buckets: [
    {
      date: "2026-11-05",
      end: "2026-11-05",
      inMinor: 245_000,
      outMinor: 0,
      netMinor: 245_000,
      count: 1,
      balanceMinor: null,
    },
    {
      date: "2026-11-08",
      end: "2026-11-08",
      inMinor: 0,
      outMinor: 4_250,
      netMinor: -4_250,
      count: 1,
      balanceMinor: null,
    },
  ],
  totals: { inMinor: 245_000, outMinor: 4_250, netMinor: 240_750, count: 2 },
};

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}

interface Server {
  detail: AccountDetailResponse | null;
  settingsHighlight: boolean;
  balanceStatus: number;
  cashflow: CashFlowResponse | null;
  syncResponse: { status: number; body: unknown };
  calls: Call[];
}

let server: Server;

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub that answers the account endpoints from `server` and records every call. */
function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      search: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    server.calls.push(call);
    const key = `${call.method} ${call.path}`;
    if (key === "GET /api/accounts/1") {
      return server.detail
        ? respond(200, server.detail)
        : respond(404, { error: "Not found", code: "not_found" });
    }
    if (key === "GET /api/accounts/1/balance-history") {
      return server.balanceStatus === 200
        ? respond(200, {
            currency: "EUR",
            points: [
              { date: "2026-08-12", balanceMinor: 300_000 },
              { date: "2026-10-01", balanceMinor: 250_000 },
              { date: "2026-11-09", balanceMinor: 420_000 },
            ],
          })
        : respond(server.balanceStatus, { error: "Not found", code: "not_found" });
    }
    if (key === "GET /api/cashflow") {
      return server.cashflow ? respond(200, server.cashflow) : respond(204);
    }
    if (key === "GET /api/transactions") return respond(200, TRANSACTIONS);
    if (key === "GET /api/settings") {
      return respond(200, {
        values: { ...SETTINGS_DEFAULTS, highlightNegativeNet: server.settingsHighlight },
        system: {
          timezone: "Europe/Rome",
          publicUrl: "http://localhost",
          enableBankingConfigured: true,
          smtpConfigured: false,
          backupTarget: "local",
        },
      });
    }
    if (key === "POST /api/accounts/1/sync") {
      return respond(server.syncResponse.status, server.syncResponse.body);
    }
    if (key === "POST /api/connections/3/renew") {
      return respond(200, { redirectUrl: "https://bank.example.test/authorise?state=abc" });
    }
    if (key === "PATCH /api/accounts/1") {
      const patch = call.body as { nickname?: string | null; status?: "active" | "disabled" };
      if (server.detail && patch.nickname !== undefined) {
        server.detail = makeDetail({
          account: {
            ...server.detail.account,
            nickname: patch.nickname,
            name: patch.nickname ?? "Conto Smart",
          },
          connection: server.detail.connection,
        });
      }
      if (server.detail && patch.status !== undefined) {
        server.detail = makeDetail({
          account: { ...server.detail.account, status: patch.status },
          connection: server.detail.connection,
        });
      }
      return respond(200, server.detail?.account);
    }
    return respond(404, { error: "Not found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(path = "/accounts/1") {
  return renderRoutes(
    [
      {
        path: "/accounts/:accountId",
        element: (
          <FormatProvider timeZone="Europe/Rome">
            <Toaster />
            <AccountDetailPage />
          </FormatProvider>
        ),
      },
      { path: "/accounts", element: <p>Accounts list</p> },
    ],
    { initialEntries: [path] },
  );
}

function callsTo(method: string, path: string): Call[] {
  return server.calls.filter((call) => call.method === method && call.path === path);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  server = {
    detail: makeDetail(),
    settingsHighlight: true,
    balanceStatus: 200,
    cashflow: CASHFLOW,
    syncResponse: { status: 202, body: { queued: 1 } },
    calls: [],
  };
  stubFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AccountDetailPage hero", () => {
  it("shows name, bank, masked IBAN, one status pill, balance and a stripe in the state colour", async () => {
    renderPage();
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toContain("Conto Smart");
    expect(screen.getByText("Banca Esempio")).not.toBeNull();
    expect(screen.getByText("IT95 •••• •••• 0001")).not.toBeNull();
    expect(screen.getByText("Active")).not.toBeNull();
    expect(screen.getByText(/4,200\.00/)).not.toBeNull();
    expect(screen.getByText("Updated 2 hours ago")).not.toBeNull();
    expect(screen.getByTestId("status-stripe").getAttribute("data-tone")).toBe("positive");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
      "Conto Smart",
    );
  });

  it.each([
    ["an expired connection", { connection: { status: "expired" as const } }, "danger"],
    ["an expiring connection", { connection: { status: "expiring" as const } }, "warning"],
    ["a disabled account", { account: { status: "disabled" as const } }, "neutral"],
    ["an unavailable account", { account: { status: "unavailable" as const } }, "warning"],
    [
      "a failed last update",
      { account: { lastSyncError: { code: "ASPSP_ERROR", at: NOW - HOUR } } },
      "warning",
    ],
  ])("colours the stripe for %s", async (_name, patch, tone) => {
    server.detail = makeDetail(patch);
    renderPage();
    expect((await screen.findByTestId("status-stripe")).getAttribute("data-tone")).toBe(tone);
  });

  it("renames the account in place and shows the new name", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    fireEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Daily account" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(callsTo("PATCH", "/api/accounts/1")).toHaveLength(1));
    expect(callsTo("PATCH", "/api/accounts/1")[0]?.body).toEqual({ nickname: "Daily account" });
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Daily account"),
    );
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
      "Daily account",
    );
  });

  it("starts a sync from the primary action and tells the owner", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(callsTo("POST", "/api/accounts/1/sync")).toHaveLength(1));
    expect(await screen.findByText("Sync started")).not.toBeNull();
    expect(
      screen.getByText("Updating Conto Smart: new transactions appear in a minute."),
    ).not.toBeNull();
  });

  it("explains a refused sync with a warning that names the account", async () => {
    server.syncResponse = {
      status: 409,
      body: { error: "Sync already running", code: "sync_in_progress" },
    };
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Already updating")).not.toBeNull();
    expect(screen.getByText("Conto Smart is being updated right now.")).not.toBeNull();
  });

  it("makes renewing the primary action when the consent ended, and leaves for the bank", async () => {
    server.detail = makeDetail({ connection: { status: "expired" } });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Renew consent" })[0] as HTMLElement);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://bank.example.test/authorise?state=abc"),
    );
    expect(callsTo("POST", "/api/connections/3/renew")).toHaveLength(1);
  });

  it("offers to enable a disabled account", async () => {
    server.detail = makeDetail({ account: { status: "disabled" } });
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByText("Disabled")).not.toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Enable account" })[0] as HTMLElement);
    await waitFor(() => expect(callsTo("PATCH", "/api/accounts/1")).toHaveLength(1));
    expect(callsTo("PATCH", "/api/accounts/1")[0]?.body).toEqual({ status: "active" });
    expect(await screen.findByText("Account enabled")).not.toBeNull();
  });

  it("shows a progress indicator instead of the freshness chip while syncing", async () => {
    server.detail = makeDetail({ account: { syncInProgress: true } });
    renderPage();
    expect(await screen.findByText("Syncing…")).not.toBeNull();
    expect(screen.queryByText("Updated 2 hours ago")).toBeNull();
    const sync = screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
    expect(sync.title).toBe("This account is being updated right now.");
  });
});

describe("AccountDetailPage tabs", () => {
  it("opens on the overview and keeps the tab in the URL", async () => {
    const { router } = renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getByRole("tab", { name: "Overview", selected: true })).not.toBeNull();
    expect(router.state.location.search).toBe("");

    fireEvent.click(screen.getByRole("tab", { name: /Transactions/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=transactions"));
    fireEvent.click(screen.getByRole("tab", { name: "Connection" }));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=connection"));
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("opens the tab named in the URL and shows the transaction count on its tab", async () => {
    renderPage("/accounts/1?tab=connection");
    expect(await screen.findByRole("tab", { name: "Connection", selected: true })).not.toBeNull();
    expect(screen.getByRole("tab", { name: /Transactions/ }).textContent).toContain("57");
    expect(screen.getByRole("tabpanel", { name: "Connection" })).not.toBeNull();
  });

  it("falls back to the overview for an unknown tab", async () => {
    renderPage("/accounts/1?tab=bogus");
    expect(await screen.findByRole("tab", { name: "Overview", selected: true })).not.toBeNull();
  });
});

describe("AccountDetailPage overview", () => {
  it("says all is good when nothing needs attention", async () => {
    renderPage();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("list", { name: "Needs attention" })).toBeNull();
    expect(
      await screen.findByText(/^All good: updated 2 hours ago and the consent is valid until/),
    ).not.toBeNull();
  });

  it.each([
    [
      "an expiring consent",
      { connection: { status: "expiring" as const, validUntil: NOW + 9 * DAY } },
      /expires in 9 days/,
      "Renew consent",
    ],
    [
      "a consent that expires tomorrow",
      { connection: { status: "expiring" as const, validUntil: NOW + DAY } },
      /expires tomorrow/,
      "Renew consent",
    ],
    [
      "a consent that expires today",
      { connection: { status: "expiring" as const, validUntil: NOW + 2 * HOUR } },
      /expires today/,
      "Renew consent",
    ],
    [
      "an expired consent",
      { connection: { status: "expired" as const, validUntil: NOW - 3 * DAY } },
      /Access to Banca Esempio has expired/,
      "Renew consent",
    ],
    [
      "a withdrawn consent",
      { connection: { status: "revoked" as const } },
      /Access to Banca Esempio was withdrawn/,
      "Renew consent",
    ],
    [
      "a connection error",
      { connection: { status: "error" as const } },
      /Bursar cannot reach Banca Esempio/,
      "Renew consent",
    ],
    [
      "an unavailable account",
      { account: { status: "unavailable" as const } },
      /no longer shares this account/,
      "See connection",
    ],
    [
      "a disabled account",
      { account: { status: "disabled" as const } },
      /This account is disabled/,
      "Enable account",
    ],
    [
      "a rate limit",
      { account: { rateLimitedUntil: NOW + HOUR } },
      /paused updates\. You can sync again/,
      "See connection",
    ],
    [
      "a failed update",
      { account: { lastSyncError: { code: "ASPSP_TIMEOUT", at: NOW - HOUR } } },
      /The last update failed\. The bank did not answer in time\. Bursar will try again later\./,
      "Sync now",
    ],
    [
      "an unknown error code",
      { account: { lastSyncError: { code: "SOMETHING_NEW", at: NOW - HOUR } } },
      /The bank did not complete the request\./,
      "Sync now",
    ],
    [
      "an account never fetched",
      { account: { lastSyncedAt: null, balance: null } },
      /has not fetched this account yet/,
      "Sync now",
    ],
  ])("raises an alert for %s with its call to action", async (_name, patch, text, cta) => {
    server.detail = makeDetail(patch);
    renderPage();
    const list = await screen.findByRole("list", { name: "Needs attention" });
    expect(within(list).getByText(text)).not.toBeNull();
    expect(within(list).getByRole("button", { name: new RegExp(`^${cta}`) })).not.toBeNull();
    expect(screen.queryByText(/^All good/)).toBeNull();
  });

  it("shows only the first-update notice while the first sync runs", async () => {
    server.detail = makeDetail({
      account: { lastSyncedAt: null, balance: null, syncInProgress: true },
    });
    renderPage();
    const list = await screen.findByRole("list", { name: "Needs attention" });
    expect(within(list).getByText(/The first update is running/)).not.toBeNull();
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("gives a removed account one notice that links to Accounts", async () => {
    server.detail = makeDetail({ account: { status: "removed" } });
    renderPage();
    const list = await screen.findByRole("list", { name: "Needs attention" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText(/was disconnected from Banca Esempio/)).not.toBeNull();
    fireEvent.click(within(list).getByRole("link", { name: /Open Accounts/ }));
    expect(await screen.findByText("Accounts list")).not.toBeNull();
  });

  it("switches to the connection tab from the call to action of an alert", async () => {
    server.detail = makeDetail({ account: { status: "unavailable" } });
    const { router } = renderPage();
    const list = await screen.findByRole("list", { name: "Needs attention" });
    fireEvent.click(within(list).getByRole("button", { name: /See connection/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=connection"));
  });

  it("does not repeat an ended consent as a failed update", async () => {
    server.detail = makeDetail({
      connection: { status: "expired" },
      account: { lastSyncError: { code: "EXPIRED_SESSION", at: NOW - HOUR } },
    });
    renderPage();
    const list = await screen.findByRole("list", { name: "Needs attention" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });

  it("runs the action behind the call to action of an alert", async () => {
    server.detail = makeDetail({
      account: { lastSyncError: { code: "ASPSP_ERROR", at: NOW - HOUR } },
    });
    renderPage();
    const list = await screen.findByRole("list", { name: "Needs attention" });
    fireEvent.click(within(list).getByRole("button", { name: /^Sync now/ }));
    await waitFor(() => expect(callsTo("POST", "/api/accounts/1/sync")).toHaveLength(1));
  });

  it("charts the last 90 days of balance and 30 days of cash flow of this account only", async () => {
    server.settingsHighlight = false;
    renderPage();
    const chart = await screen.findByTestId("balance-chart");
    expect(chart.getAttribute("data-points")).toBe("3");
    expect(chart.getAttribute("data-currency")).toBe("EUR");
    expect(chart.textContent).toMatch(
      /^Balance from .* to .*: .*3,000\.00 at the start, .*4,200\.00 at the end, lowest .*2,500\.00, highest .*4,200\.00\.$/,
    );
    expect(callsTo("GET", "/api/accounts/1/balance-history")[0]?.search.get("days")).toBe("90");

    const strip = await screen.findByTestId("cashflow-strip");
    expect(strip.getAttribute("data-variant")).toBe("full");
    expect(strip.getAttribute("data-show-balance")).toBe("false");
    expect(strip.getAttribute("data-buckets")).toBe("2");
    await waitFor(() =>
      expect(screen.getByTestId("cashflow-strip").getAttribute("data-highlight")).toBe("false"),
    );
    const flow = callsTo("GET", "/api/cashflow")[0];
    expect(flow?.search.get("accountId")).toBe("1");
    expect(flow?.search.get("currency")).toBe("EUR");
    expect(flow?.search.get("from")).toBe("2026-10-11");
    expect(flow?.search.get("to")).toBe("2026-11-09");
  });

  it("explains an empty balance history and an empty cash flow instead of drawing nothing", async () => {
    server.balanceStatus = 404;
    server.cashflow = null;
    renderPage();
    expect(await screen.findByText("No balance history yet")).not.toBeNull();
    expect(await screen.findByText("No transactions in this period")).not.toBeNull();
    expect(screen.queryByTestId("balance-chart")).toBeNull();
    expect(screen.queryByTestId("cashflow-strip")).toBeNull();
  });

  it("shows an error with a retry when the balance history fails", async () => {
    server.balanceStatus = 500;
    renderPage();
    expect(await screen.findByText("The chart could not be loaded")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });
});

describe("AccountDetailPage transactions", () => {
  it("lists the latest transactions and has no link to the full list until it exists", async () => {
    renderPage("/accounts/1?tab=transactions");
    const table = await screen.findByRole("table", { name: "Latest transactions of this account" });
    await within(table).findByText("Mercato Verde");
    expect(within(table).getByText("Mercato Verde")).not.toBeNull();
    expect(within(table).getByText("Employer Srl")).not.toBeNull();
    expect(within(table).getByText("Pending")).not.toBeNull();
    expect(within(table).getByText("Yesterday")).not.toBeNull();
    expect(within(table).getByText("Today")).not.toBeNull();
    expect(within(table).getByText(/42\.50/)).not.toBeNull();
    expect(screen.getByText("Showing the latest 3 of 57 transactions")).not.toBeNull();
    const request = callsTo("GET", "/api/transactions")[0];
    expect(request?.search.get("accountId")).toBe("1");
    expect(request?.search.get("pageSize")).toBe("20");
    expect(document.querySelector('a[href^="/transactions"]')).toBeNull();
  });

  it("shows the absolute date of a transaction in its title", async () => {
    renderPage("/accounts/1?tab=transactions");
    const table = await screen.findByRole("table");
    const time = await within(table).findByText("Yesterday");
    expect(time.getAttribute("datetime")).toBe("2026-11-08");
    expect(time.getAttribute("title")).toMatch(/8 November 2026|08 November 2026/);
  });
});

describe("AccountDetailPage connection", () => {
  it("shows the consent, the dates and the actions of an active connection", async () => {
    renderPage("/accounts/1?tab=connection");
    await screen.findByRole("tab", { name: "Connection", selected: true });
    expect(screen.getByText("Consent expires in 88 days")).not.toBeNull();
    expect(screen.getByText("Not renewed yet")).not.toBeNull();
    expect(screen.getByText("No errors recorded.")).not.toBeNull();
    const panel = screen.getByRole("tabpanel", { name: "Connection" });
    expect(within(panel).getByRole("button", { name: "Sync now" })).not.toBeNull();
    expect(within(panel).getByRole("button", { name: "Renew consent" })).not.toBeNull();
    expect(within(panel).getByRole("button", { name: "Disconnect bank" })).not.toBeNull();
  });

  it("blocks syncing on an ended consent and says why", async () => {
    server.detail = makeDetail({
      connection: {
        status: "expired",
        validUntil: NOW - 3 * DAY,
        lastError: { code: "EXPIRED_SESSION", message: "internal text", at: NOW - 100 * HOUR },
      },
    });
    renderPage("/accounts/1?tab=connection");
    await screen.findByRole("tab", { name: "Connection", selected: true });
    expect(screen.getByText("Consent expired 3 days ago")).not.toBeNull();
    expect(screen.getByText(/^Connection: The bank consent has expired\./)).not.toBeNull();
    expect(screen.queryByText(/internal text/)).toBeNull();
    const panel = screen.getByRole("tabpanel", { name: "Connection" });
    const sync = within(panel).getByRole("button", { name: "Sync now" }) as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
    expect(sync.title).toBe("The consent has ended. Renew it to sync again.");
    expect(
      within(panel).getByRole("button", { name: "Renew consent" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("opens the disconnect dialog for the bank, never showing an id", async () => {
    renderPage("/accounts/1?tab=connection");
    await screen.findByRole("tab", { name: "Connection", selected: true });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect bank" }));
    expect(screen.getByRole("dialog", { name: "Disconnect Banca Esempio?" })).not.toBeNull();
  });

  it("offers no actions for a removed account", async () => {
    server.detail = makeDetail({ account: { status: "removed" } });
    renderPage("/accounts/1?tab=connection");
    await screen.findByRole("tab", { name: "Connection", selected: true });
    const panel = screen.getByRole("tabpanel", { name: "Connection" });
    expect(within(panel).queryByRole("button")).toBeNull();
    expect(
      within(panel).getByText(/was disconnected, so there is nothing to renew or sync/),
    ).not.toBeNull();
  });

  it("renders the sync history with results, translated errors and skip reasons", async () => {
    renderPage("/accounts/1?tab=connection");
    const table = await screen.findByRole("table", { name: "Sync history of this account" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("Manual")).not.toBeNull();
    expect(within(table).getByText("Succeeded")).not.toBeNull();
    expect(within(table).getByText("3 new · 1 updated")).not.toBeNull();
    expect(within(table).getByText("Failed")).not.toBeNull();
    expect(
      within(table).getByText("The bank consent has expired. Renew it to resume syncing."),
    ).not.toBeNull();
    expect(within(table).getByText("Skipped")).not.toBeNull();
    expect(within(table).getByText("Skipped: the bank is limiting requests")).not.toBeNull();
    expect(within(table).queryByText("EXPIRED_SESSION")).toBeNull();
  });

  it("explains an account that has never synced", async () => {
    server.detail = makeDetail({ syncRuns: [], account: { lastSyncedAt: null, balance: null } });
    renderPage("/accounts/1?tab=connection");
    expect(await screen.findByText("No syncs yet")).not.toBeNull();
    expect(screen.getByText("Never")).not.toBeNull();
  });
});

describe("AccountDetailPage states", () => {
  it("shows the not-found state for a missing or purged account without echoing the id", async () => {
    server.detail = null;
    renderPage("/accounts/1");
    expect(await screen.findByText("Account not found")).not.toBeNull();
    expect(screen.getByText("This account does not exist or was removed.")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain(
      "Not found",
    );
    expect(document.body.textContent).not.toMatch(/\b1\b/);
    fireEvent.click(screen.getByRole("button", { name: "Back to Accounts" }));
    expect(await screen.findByText("Accounts list")).not.toBeNull();
  });

  it("treats a malformed id as not found without calling the API", async () => {
    renderPage("/accounts/abc");
    expect(await screen.findByText("Account not found")).not.toBeNull();
    expect(document.body.textContent).not.toContain("abc");
    expect(server.calls.filter((call) => call.path.startsWith("/api/accounts"))).toHaveLength(0);
  });

  it("shows an error state with a retry when the server fails", async () => {
    const failing = vi.fn(async () => respond(500, { error: "Internal error" }));
    vi.stubGlobal("fetch", failing);
    renderPage();
    expect(await screen.findByText("The account could not be loaded")).not.toBeNull();
    failing.mockImplementation(async () => respond(200, makeDetail()));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toContain("Conto Smart");
  });

  it("shows a busy skeleton while loading and clears it afterwards", async () => {
    const { container } = renderPage();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
  });

  it("reads in Italian", async () => {
    await i18n.changeLanguage("it");
    renderPage("/accounts/1?tab=connection");
    expect(await screen.findByRole("tab", { name: "Collegamento", selected: true })).not.toBeNull();
    expect(screen.getAllByText("Attivo").length).toBeGreaterThan(0);
    expect(screen.getByText("Il consenso scade tra 88 giorni")).not.toBeNull();
    await i18n.changeLanguage("en");
  });
});
