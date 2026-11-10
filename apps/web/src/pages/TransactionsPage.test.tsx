import {
  type AccountSummary,
  addDays,
  type CashFlowBucket,
  type CashFlowResponse,
  type ConnectionsResponse,
  formatLocalDate,
  type LocalDate,
  type TransactionDetail,
  type TransactionItem,
  type TransactionListResponse,
  toLocalDate,
  transactionQuerySchema,
} from "@bursar/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { FormatProvider } from "../lib/format";
import { useUi } from "../store/ui";
import { renderRoutes } from "../test/router";
import { TransactionsPage } from "./TransactionsPage";

vi.mock("../components/charts/CashFlowStrip", () => ({
  CashFlowStrip: (props: {
    buckets: CashFlowBucket[];
    summaryLabel: string;
    onSelectBucket?: (bucket: CashFlowBucket) => void;
  }) => (
    <div>
      <p>{props.summaryLabel}</p>
      {props.buckets.map((bucket) => (
        <button key={bucket.date} type="button" onClick={() => props.onSelectBucket?.(bucket)}>
          {`bucket ${bucket.date}`}
        </button>
      ))}
    </div>
  ),
}));

const TZ = "Europe/Rome";
const today = toLocalDate(Date.now(), TZ);
const yesterday = addDays(today, -1);
const twoDaysAgo = addDays(today, -2);
const from30 = addDays(today, -29);

function item(overrides: Partial<TransactionItem> & Pick<TransactionItem, "id">): TransactionItem {
  return {
    accountId: 1,
    accountName: "Conto corrente",
    status: "booked",
    date: yesterday,
    bookingDate: yesterday,
    valueDate: yesterday,
    amountMinor: -4210,
    currency: "EUR",
    counterparty: "Caffè Centrale",
    description: "Card payment 4021",
    ...overrides,
  };
}

const CAFE = item({ id: 101 });
const SALARY = item({
  id: 102,
  status: "pending",
  bookingDate: null,
  amountMinor: 234050,
  counterparty: "Northwind Payroll",
  description: "Salary",
});
const TRANSIT = item({
  id: 103,
  accountId: 2,
  accountName: "Savings",
  date: twoDaysAgo,
  bookingDate: twoDaysAgo,
  valueDate: twoDaysAgo,
  amountMinor: -1250,
  counterparty: "City Transit",
  description: "Monthly pass",
});

function bucket(date: LocalDate, inMinor: number, outMinor: number): CashFlowBucket {
  return {
    date,
    end: date,
    inMinor,
    outMinor,
    netMinor: inMinor - outMinor,
    count: 1,
    balanceMinor: null,
  };
}

function aggregate(overrides: Partial<CashFlowResponse> = {}): CashFlowResponse {
  return {
    currency: "EUR",
    currencies: ["EUR"],
    from: from30,
    to: today,
    bucket: "day",
    buckets: [bucket(twoDaysAgo, 0, 1250), bucket(yesterday, 234050, 4210)],
    totals: { inMinor: 234050, outMinor: 5460, netMinor: 228590, count: 3 },
    ...overrides,
  };
}

function listResponse(overrides: Partial<TransactionListResponse> = {}): TransactionListResponse {
  const items = overrides.items ?? [CAFE, SALARY, TRANSIT];
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    facets: { all: 3, in: 1, out: 2, pending: 1 },
    aggregate: aggregate(),
    ...overrides,
  };
}

const EMPTY_LIST = listResponse({
  items: [],
  total: 0,
  facets: { all: 0, in: 0, out: 0, pending: 0 },
  aggregate: aggregate({
    from: today,
    to: today,
    buckets: [bucket(today, 0, 0)],
    totals: { inMinor: 0, outMinor: 0, netMinor: 0, count: 0 },
  }),
});

function account(id: number, name: string): AccountSummary {
  return {
    id,
    connectionId: 1,
    name,
    nickname: null,
    bankProduct: name,
    maskedIdentifier: "IT60 •••• •••• 1234",
    iban: null,
    last4: "1234",
    currency: "EUR",
    cashAccountType: "CACC",
    status: "active",
    balance: null,
    net30d: { inMinor: 0, outMinor: 0, netMinor: 0 },
    daily30d: [],
    lastSyncedAt: null,
    lastSyncError: null,
    rateLimitedUntil: null,
    syncInProgress: false,
  };
}

const CONNECTIONS: ConnectionsResponse = {
  connections: [
    {
      id: 1,
      bankName: "Banca Esempio",
      country: "IT",
      hasLogo: false,
      status: "active",
      validUntil: Date.UTC(2027, 4, 1),
      createdAt: Date.UTC(2026, 9, 1),
      renewedAt: null,
      lastError: null,
      accounts: [account(1, "Conto corrente"), account(2, "Savings")],
    },
  ],
  removedAccounts: [
    {
      id: 7,
      name: "Old card",
      maskedIdentifier: "•••• 9876",
      bankName: "Northwind Bank",
      transactionCount: 42,
      removedAt: Date.UTC(2026, 8, 1),
    },
  ],
};

const DETAIL: TransactionDetail = {
  ...CAFE,
  transactionDate: null,
  providerReference: "REF-2026-000101",
  counterpartyAccount: null,
  remittanceLines: [],
  bankCode: null,
  merchantCategoryCode: null,
  balanceAfter: null,
  firstSeenAt: Date.UTC(2026, 10, 6, 9, 30),
  lastSeenAt: Date.UTC(2026, 10, 8, 9, 30),
  bankName: "Banca Esempio",
};

interface Call {
  method: string;
  path: string;
  params: Record<string, string>;
}
type Reply = { status: number; body?: unknown };

let calls: Call[] = [];

function stubFetch(handler: (call: Call) => Reply | undefined): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const call: Call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        params: Object.fromEntries(url.searchParams),
      };
      calls.push(call);
      const reply = handler(call) ?? { status: 404, body: { error: "Not found" } };
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function apiHandler(
  list: (params: Record<string, string>) => TransactionListResponse = () => listResponse(),
) {
  return (call: Call): Reply | undefined => {
    if (call.path === "/api/transactions") return { status: 200, body: list(call.params) };
    if (call.path === "/api/transactions/101") return { status: 200, body: DETAIL };
    if (call.path === "/api/connections") return { status: 200, body: CONNECTIONS };
    return undefined;
  };
}

/** Parameters of the latest list request (probe requests carry `pageSize`, the list never does). */
function lastList(): Record<string, string> | undefined {
  return calls
    .filter((call) => call.path === "/api/transactions" && call.params.pageSize === undefined)
    .at(-1)?.params;
}

function renderPage(path = "/transactions") {
  return renderRoutes(
    [
      {
        path: "/transactions",
        element: (
          <FormatProvider timeZone={TZ}>
            <TransactionsPage />
          </FormatProvider>
        ),
      },
      { path: "/accounts", element: <p>Accounts page</p> },
      { path: "/accounts/:accountId", element: <p>Account page</p> },
    ],
    { initialEntries: [path] },
  );
}

type Rendered = ReturnType<typeof renderPage>;

function urlParams(router: Rendered["router"]): URLSearchParams {
  return new URLSearchParams(router.state.location.search);
}

async function findTable(): Promise<HTMLElement> {
  const table = await screen.findByRole("table", { name: "Transactions" });
  await within(table).findAllByText("Caffè Centrale");
  return table;
}

describe("TransactionsPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useUi.setState({ privacy: false });
  });

  it("loads the last 30 days with nothing in the URL and renders the rows", async () => {
    stubFetch(apiHandler());
    const { router } = renderPage();
    const table = await findTable();
    expect(router.state.location.search).toBe("");
    expect(lastList()).toEqual({ from: from30, to: today });
    expect(transactionQuerySchema.safeParse(lastList()).success).toBe(true);
    const heading = screen.getByRole("heading", { level: 1, name: "Transactions" });
    expect(heading.parentElement?.textContent).toContain("3");
    const day = within(table).getAllByText("Yesterday")[0];
    expect(day?.getAttribute("title")).toBe(
      formatLocalDate(yesterday, "en-GB", { style: "long", weekday: true }),
    );
    expect(within(table).getAllByText("-€42.10").length).toBeGreaterThan(0);
    expect(within(table).getAllByText("+€2,340.50").length).toBeGreaterThan(0);
    expect(within(table).getByText("Pending")).toBeTruthy();
    expect(within(table).getAllByText("Savings").length).toBeGreaterThan(0);
    expect(screen.queryByText("REF-2026-000101")).toBeNull();
    expect(screen.queryByText(/results? of/)).toBeNull();
  });

  it("toggles the direction from the In and Out figures and clears it from Net", async () => {
    stubFetch(apiHandler());
    const { router } = renderPage();
    const inFigure = await screen.findByRole("button", { name: /^In/ });
    expect(inFigure.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(inFigure);
    await waitFor(() => expect(urlParams(router).get("tab")).toBe("in"));
    expect(screen.getByRole("button", { name: /^In/ }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(lastList()?.tab).toBe("in"));
    fireEvent.click(screen.getByRole("button", { name: /^In/ }));
    await waitFor(() => expect(urlParams(router).get("tab")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Out/ }));
    await waitFor(() => expect(urlParams(router).get("tab")).toBe("out"));
    fireEvent.click(screen.getByRole("button", { name: /^Net/ }));
    await waitFor(() => expect(urlParams(router).get("tab")).toBeNull());
  });

  it("shows faceted counts on the tabs and returns to page 1 when the tab changes", async () => {
    stubFetch(apiHandler(() => listResponse({ total: 45 })));
    const { router } = renderPage("/transactions?page=2");
    await findTable();
    expect(screen.getByRole("tab", { name: /^All/ }).textContent).toBe("All3");
    expect(screen.getByRole("tab", { name: /^Inflows/ }).textContent).toBe("Inflows1");
    expect(screen.getByRole("tab", { name: /^Outflows/ }).textContent).toBe("Outflows2");
    expect(screen.getByRole("tab", { name: /^Pending/ }).textContent).toBe("Pending1");
    expect(lastList()?.page).toBe("2");
    fireEvent.click(screen.getByRole("tab", { name: /^Outflows/ }));
    await waitFor(() => expect(urlParams(router).get("tab")).toBe("out"));
    expect(urlParams(router).get("page")).toBeNull();
    await waitFor(() => expect(lastList()).toEqual({ tab: "out", from: from30, to: today }));
  });

  it("reads invalid URL values as their defaults", async () => {
    stubFetch(apiHandler());
    renderPage(
      "/transactions?tab=bogus&period=7d&sort=size&order=up&page=0&accountId=abc&currency=euro&from=2026-02-30&tx=x",
    );
    await findTable();
    expect(lastList()).toEqual({ from: from30, to: today });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("Period") as HTMLSelectElement).value).toBe("30d");
    expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("tab", { name: /^All/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("debounces the search, shows its chip and the results line, and clears it", async () => {
    stubFetch(
      apiHandler((params) => (params.q ? listResponse({ items: [CAFE] }) : listResponse())),
    );
    const { router } = renderPage();
    await findTable();
    const box = screen.getByRole("searchbox", { name: "Search transactions" });
    expect(box.getAttribute("placeholder")).toBe("Search counterparty, description or amount");
    fireEvent.change(box, { target: { value: "caffe" } });
    expect(urlParams(router).get("q")).toBeNull();
    await waitFor(() => expect(urlParams(router).get("q")).toBe("caffe"));
    await waitFor(() => expect(lastList()?.q).toBe("caffe"));
    expect(await screen.findByText("1 result of 3")).toBeTruthy();
    expect(screen.getByText("Search: “caffe”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(urlParams(router).get("q")).toBeNull());
    expect(
      (screen.getByRole("searchbox", { name: "Search transactions" }) as HTMLInputElement).value,
    ).toBe("");
  });

  it("filters by account, disconnected accounts included, with a chip naming it", async () => {
    stubFetch(apiHandler());
    const { router } = renderPage();
    await findTable();
    const select = screen.getByLabelText("Account") as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
        "All accounts",
        "Conto corrente · Banca Esempio",
        "Savings · Banca Esempio",
        "Old card · Northwind Bank (disconnected)",
      ]),
    );
    fireEvent.change(select, { target: { value: "2" } });
    await waitFor(() => expect(urlParams(router).get("accountId")).toBe("2"));
    await waitFor(() => expect(lastList()?.accountId).toBe("2"));
    expect(screen.getByText("Account: Savings")).toBeTruthy();
  });

  it("sets a custom period from a click on an aggregate bar", async () => {
    stubFetch(apiHandler());
    const { router } = renderPage();
    await findTable();
    fireEvent.click(screen.getByRole("button", { name: `bucket ${yesterday}` }));
    await waitFor(() => expect(urlParams(router).get("period")).toBe("custom"));
    expect(urlParams(router).get("from")).toBe(yesterday);
    expect(urlParams(router).get("to")).toBe(yesterday);
    await waitFor(() => expect(lastList()).toEqual({ from: yesterday, to: yesterday }));
    expect(screen.getByText(`Period: ${formatLocalDate(yesterday, "en-GB")}`)).toBeTruthy();
  });

  it("reads a link with only from and to as a custom period", async () => {
    stubFetch(apiHandler());
    renderPage(`/transactions?from=${twoDaysAgo}&to=${yesterday}`);
    await findTable();
    expect(lastList()).toEqual({ from: twoDaysAgo, to: yesterday });
    expect((screen.getByLabelText("Period") as HTMLSelectElement).value).toBe("custom");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe(twoDaysAgo);
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe(yesterday);
  });

  it("switches between period presets and a custom range", async () => {
    stubFetch(apiHandler());
    const { router } = renderPage();
    await findTable();
    const period = screen.getByLabelText("Period") as HTMLSelectElement;
    expect(Array.from(period.options).map((option) => option.textContent)).toEqual([
      "Last 30 days",
      "Last 90 days",
      "Last 12 months",
      "All time",
      "Custom range",
    ]);
    fireEvent.change(period, { target: { value: "90d" } });
    await waitFor(() => expect(urlParams(router).get("period")).toBe("90d"));
    await waitFor(() => expect(lastList()).toEqual({ from: addDays(today, -89), to: today }));
    expect(screen.getByText("Period: Last 90 days")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "custom" } });
    await waitFor(() => expect(urlParams(router).get("period")).toBe("custom"));
    expect(urlParams(router).get("from")).toBe(addDays(today, -89));
    expect(urlParams(router).get("to")).toBe(today);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: twoDaysAgo } });
    await waitFor(() => expect(urlParams(router).get("from")).toBe(twoDaysAgo));
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "all" } });
    await waitFor(() => expect(urlParams(router).get("period")).toBe("all"));
    expect(urlParams(router).get("from")).toBeNull();
    await waitFor(() => expect(lastList()).toEqual({}));
  });

  it("cycles the server sort ascending, descending and back to none", async () => {
    stubFetch(apiHandler());
    const { router } = renderPage();
    const table = await findTable();
    fireEvent.click(within(table).getByRole("button", { name: "Amount" }));
    await waitFor(() => expect(urlParams(router).get("sort")).toBe("amount"));
    expect(urlParams(router).get("order")).toBe("asc");
    await waitFor(() => expect(lastList()).toMatchObject({ sort: "amount", order: "asc" }));
    fireEvent.click(within(table).getByRole("button", { name: "Amount" }));
    await waitFor(() => expect(urlParams(router).get("order")).toBeNull());
    expect(urlParams(router).get("sort")).toBe("amount");
    fireEvent.click(within(table).getByRole("button", { name: "Amount" }));
    await waitFor(() => expect(urlParams(router).get("sort")).toBeNull());
    await waitFor(() => expect(lastList()).toEqual({ from: from30, to: today }));
  });

  it("opens the drawer from a row without leaving the page and closes it", async () => {
    stubFetch(apiHandler(() => listResponse({ total: 25 })));
    const { router } = renderPage("/transactions?page=2");
    const table = await findTable();
    expect(await screen.findByText("21–25 of 25")).toBeTruthy();
    fireEvent.click(within(table).getAllByText("Caffè Centrale")[0] as HTMLElement);
    await waitFor(() => expect(urlParams(router).get("tx")).toBe("101"));
    expect(urlParams(router).get("page")).toBe("2");
    const dialog = await screen.findByRole("dialog", { name: "Transaction" });
    expect(await within(dialog).findByText("REF-2026-000101")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(urlParams(router).get("tx")).toBeNull());
    expect(urlParams(router).get("page")).toBe("2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers a currency switch and the no-conversion note with mixed currencies", async () => {
    stubFetch(
      apiHandler(() => listResponse({ aggregate: aggregate({ currencies: ["EUR", "USD"] }) })),
    );
    const { router } = renderPage();
    await findTable();
    const group = screen.getByRole("group", { name: "Currency" });
    expect(within(group).getByRole("button", { name: "EUR" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      screen.getByText(
        "Totals are per currency, with no conversion. Each row keeps its own currency.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "USD" }));
    await waitFor(() => expect(urlParams(router).get("currency")).toBe("USD"));
    await waitFor(() => expect(lastList()?.currency).toBe("USD"));
  });

  it("shows the filter-empty state with Clear filters", async () => {
    stubFetch(apiHandler((params) => (params.q ? EMPTY_LIST : listResponse())));
    const { router } = renderPage("/transactions?q=zzzz");
    expect(await screen.findByText("No transactions match the filters")).toBeTruthy();
    expect(await screen.findByText("0 results of 3")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Clear filters" });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => expect(urlParams(router).get("q")).toBeNull());
    await findTable();
  });

  it("shows the true-empty state when there is no transaction at all", async () => {
    stubFetch(apiHandler(() => EMPTY_LIST));
    renderPage();
    expect(await screen.findByText("No transactions yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open accounts" }).getAttribute("href")).toBe(
      "/accounts",
    );
    expect(
      calls.some(
        (call) =>
          call.path === "/api/transactions" &&
          call.params.pageSize === "10" &&
          call.params.from === undefined,
      ),
    ).toBe(true);
  });

  it("tells an empty period apart from an empty account set", async () => {
    stubFetch(apiHandler((params) => (params.from ? EMPTY_LIST : listResponse({ total: 5 }))));
    const { router } = renderPage();
    expect(await screen.findByText("No transactions in this period")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all periods" }));
    await waitFor(() => expect(urlParams(router).get("period")).toBe("all"));
    await findTable();
  });

  it("shows a positive line when nothing is pending", async () => {
    stubFetch(apiHandler((params) => (params.tab === "pending" ? EMPTY_LIST : listResponse())));
    renderPage("/transactions?tab=pending");
    expect(await screen.findByText("Nothing pending")).toBeTruthy();
    expect(screen.getByText("All good: every transaction in this view is booked.")).toBeTruthy();
  });

  it("shows an error state with a retry instead of invented data", async () => {
    let failing = true;
    const ok = apiHandler();
    stubFetch((call) =>
      call.path === "/api/transactions" && failing
        ? { status: 500, body: { error: "Internal error" } }
        : ok(call),
    );
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Transactions could not be loaded");
    expect(screen.queryByRole("table")).toBeNull();
    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await findTable();
  });

  it("masks every amount in the rows and the aggregate in privacy mode", async () => {
    useUi.setState({ privacy: true });
    stubFetch(apiHandler());
    renderPage();
    await findTable();
    const text = document.body.textContent ?? "";
    for (const digits of ["42.10", "2,340.50", "12.50", "54.60", "2,285.90"]) {
      expect(text).not.toContain(digits);
    }
    expect(screen.getAllByRole("img", { name: "Amount hidden" }).length).toBeGreaterThanOrEqual(9);
  });

  it("speaks Italian", async () => {
    await i18n.changeLanguage("it");
    stubFetch(apiHandler());
    renderPage();
    expect(await screen.findByRole("heading", { level: 1, name: "Movimenti" })).toBeTruthy();
    await screen.findByRole("table", { name: "Movimenti" });
    expect(screen.getByRole("tab", { name: /^Entrate/ })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Uscite/ })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Cerca nei movimenti" })).toBeTruthy();
    expect(
      (screen.getByLabelText("Periodo") as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe("Ultimi 30 giorni");
  });
});
