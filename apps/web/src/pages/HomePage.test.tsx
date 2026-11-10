import {
  type AccountSummary,
  addDays,
  type CashFlowBucket,
  type CashFlowResponse,
  type HomeSummary,
  SETTINGS_DEFAULTS,
  type SettingsResponse,
} from "@bursar/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { FormatProvider } from "../lib/format";
import { useUi } from "../store/ui";
import { HomePage } from "./HomePage";

// Home links to pages that ship in later tasks. These tests check the final targets, so
// they report every route as shipped; ShippedLink.test.tsx covers unshipped routes.
vi.mock("../app/routes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/routes")>();
  return {
    ...actual,
    routeById: (id: Parameters<typeof actual.routeById>[0]) => ({
      ...actual.routeById(id),
      shipped: true,
    }),
  };
});

// The Recharts drawing is covered by CashFlowStrip.test.tsx; here only the strip's own
// text, keyboard list and selection matter.
vi.mock("../components/charts/CashFlowChart", () => ({ default: () => null }));

const NOW = Date.UTC(2026, 10, 9, 9, 0); // Monday 9 November 2026, 10:00 in Rome
const HOUR = 3_600_000;
const JSON_HEADERS = { "content-type": "application/json" };

type Activity = Record<string, { in: number; out: number; count: number }>;

const EUR_ACTIVITY: Activity = {
  "2026-11-01": { in: 250_000, out: 1_200, count: 2 },
  "2026-11-05": { in: 0, out: 4_550, count: 3 },
};
const USD_ACTIVITY: Activity = { "2026-11-03": { in: 100_000, out: 2_000, count: 2 } };

function cashflowFor(currency: string, currencies: string[], activity: Activity): CashFlowResponse {
  const buckets: CashFlowBucket[] = [];
  let balance = 500_000;
  for (let day = 0; day < 30; day += 1) {
    const date = addDays("2026-10-11", day);
    const flow = activity[date] ?? { in: 0, out: 0, count: 0 };
    balance += flow.in - flow.out;
    buckets.push({
      date,
      end: date,
      inMinor: flow.in,
      outMinor: flow.out,
      netMinor: flow.in - flow.out,
      count: flow.count,
      balanceMinor: balance,
    });
  }
  const sum = (pick: (bucket: CashFlowBucket) => number) =>
    buckets.reduce((total, bucket) => total + pick(bucket), 0);
  return {
    currency,
    currencies,
    from: "2026-10-11",
    to: "2026-11-09",
    bucket: "day",
    buckets,
    totals: {
      inMinor: sum((b) => b.inMinor),
      outMinor: sum((b) => b.outMinor),
      netMinor: sum((b) => b.netMinor),
      count: sum((b) => b.count),
    },
  };
}

function account(overrides: Partial<AccountSummary> & Pick<AccountSummary, "id" | "name">) {
  const base: AccountSummary = {
    id: overrides.id,
    connectionId: 1,
    name: overrides.name,
    nickname: null,
    bankProduct: "Current account",
    maskedIdentifier: "IT60 •••• •••• 1234",
    iban: null,
    last4: "1234",
    currency: "EUR",
    cashAccountType: "CACC",
    status: "active",
    balance: { amountMinor: 371_025, currency: "EUR", type: "ITBD", asOf: NOW - HOUR },
    net30d: { inMinor: 250_000, outMinor: 5_750, netMinor: 244_250 },
    daily30d: [],
    lastSyncedAt: NOW - 2 * HOUR,
    lastSyncError: null,
    rateLimitedUntil: null,
    syncInProgress: false,
  };
  return { ...base, ...overrides };
}

function summary(overrides: Partial<HomeSummary> = {}): HomeSummary {
  return {
    generatedAt: NOW,
    balances: [{ currency: "EUR", amountMinor: 742_050, accountCount: 2 }],
    cashflow30d: cashflowFor("EUR", ["EUR"], EUR_ACTIVITY),
    accounts: [
      account({ id: 1, name: "Everyday account" }),
      account({ id: 2, name: "Rainy day savings", lastSyncedAt: NOW - 5 * HOUR }),
    ],
    alerts: [],
    hasConnections: true,
    ...overrides,
  };
}

const SETTINGS: SettingsResponse = {
  values: { ...SETTINGS_DEFAULTS },
  system: {
    timezone: "Europe/Rome",
    publicUrl: "https://bursar.example.test",
    enableBankingConfigured: true,
    smtpConfigured: false,
    backupTarget: "local",
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function stubApi(handlers: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const handler =
      handlers[url.pathname] ??
      (url.pathname === "/api/settings" ? () => json(SETTINGS) : undefined);
    return handler ? handler() : json({ error: "Not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderHome(path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <FormatProvider timeZone="Europe/Rome">
          <HomePage />
        </FormatProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await i18n.changeLanguage("en");
  useUi.setState({ privacy: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HomePage", () => {
  it("greets with the date and a sentence that links to the most urgent alert", async () => {
    stubApi({
      "/api/summary": () =>
        json(
          summary({
            alerts: [
              { kind: "backup_local_only" },
              { kind: "consent_expiring", connectionId: 2, bankName: "Northwind Bank", days: 9 },
              { kind: "consent_expired", connectionId: 3, bankName: "Banca Esempio" },
            ],
          }),
        ),
    });
    renderHome();

    expect(screen.getByRole("heading", { level: 1, name: "Good morning" })).toBeTruthy();
    expect(screen.getByText(/9 November 2026/)).toBeTruthy();
    expect(await screen.findByText("2 things need your attention. Most urgent:")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Consent for Banca Esempio has expired" })
        .getAttribute("href"),
    ).toBe("/accounts");

    const alerts = screen.getByRole("region", { name: "Needs attention" });
    const titles = within(alerts)
      .getAllByRole("listitem")
      .map((item) => item.querySelector("p")?.textContent);
    expect(titles).toEqual([
      "Consent for Banca Esempio has expired",
      "Consent for Northwind Bank expires in 9 days",
      "Backups are kept on this server only",
    ]);
    expect(
      within(alerts)
        .getAllByRole("link", { name: "Renew consent" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/accounts", "/accounts"]);
    expect(
      within(alerts).getByRole("link", { name: "Open the backup settings" }).getAttribute("href"),
    ).toBe("/settings#backups");
  });

  it("shows the key figures, the accounts with their freshness and the positive state", async () => {
    stubApi({ "/api/summary": () => json(summary({ alerts: [{ kind: "backup_local_only" }] })) });
    renderHome();

    const balance = await screen.findByRole("link", { name: /^Balance/ });
    expect(balance.getAttribute("href")).toBe("/accounts");
    expect(balance.textContent).toContain("€7,420.50");
    expect(balance.textContent).toContain("2 accounts");
    const inflow = screen.getByRole("link", { name: /^In, last 30 days/ });
    expect(inflow.getAttribute("href")).toBe("/transactions?tab=in");
    expect(inflow.textContent).toContain("€2,500.00");
    const outflow = screen.getByRole("link", { name: /^Out, last 30 days/ });
    expect(outflow.getAttribute("href")).toBe("/transactions?tab=out");
    expect(outflow.textContent).toContain("€57.50");
    const net = screen.getByRole("link", { name: /^Net, last 30 days/ });
    expect(net.getAttribute("href")).toBe("/transactions");
    expect(net.textContent).toContain("+€2,442.50");

    const accounts = screen.getByRole("region", { name: "Accounts" });
    expect(
      within(accounts)
        .getByRole("link", { name: /Everyday account/ })
        .getAttribute("href"),
    ).toBe("/accounts/1");
    expect(within(accounts).getByText("Updated 2 hours ago")).toBeTruthy();
    expect(screen.getByText("All good: every account was updated today.")).toBeTruthy();
  });

  it("names the oldest update when nothing needs attention but an account is behind", async () => {
    stubApi({
      "/api/summary": () =>
        json(
          summary({
            accounts: [
              account({ id: 1, name: "Everyday account" }),
              account({ id: 2, name: "Rainy day savings", lastSyncedAt: NOW - 30 * HOUR }),
            ],
          }),
        ),
    });
    renderHome();
    expect(
      await screen.findByText("Nothing needs your attention. The oldest update was yesterday."),
    ).toBeTruthy();
  });

  it("explains what Bursar does when no bank is connected, with no button yet", async () => {
    stubApi({
      "/api/summary": () =>
        json(summary({ hasConnections: false, accounts: [], balances: [], cashflow30d: null })),
    });
    renderHome();
    expect(await screen.findByText("No bank connected yet")).toBeTruthy();
    expect(screen.getByText(/It only reads: it cannot make payments or move money\./)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Key figures" })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows an error state with a retry instead of invented data", async () => {
    let calls = 0;
    stubApi({
      "/api/summary": () => {
        calls += 1;
        return calls === 1 ? json({ error: "Internal error" }, 500) : json(summary());
      },
    });
    renderHome();
    expect(await screen.findByText("The overview could not be loaded")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Key figures" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("All good: every account was updated today.")).toBeTruthy();
  });

  it("selects a day on the strip and links to its transactions", async () => {
    stubApi({ "/api/summary": () => json(summary()) });
    renderHome();
    expect(await screen.findByText("Select a day to see its figures.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^5 Nov:/ }));
    const link = await screen.findByRole("link", { name: "See 3 transactions on 5 Nov" });
    expect(link.getAttribute("href")).toBe("/transactions?from=2026-11-05&to=2026-11-05");
    expect(screen.getByRole("button", { name: /^5 Nov:/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /^See 3 transactions/ })).toBeNull(),
    );
  });

  it("keeps currencies apart and switches the strip and the figures to another currency", async () => {
    const fetchMock = stubApi({
      "/api/summary": () =>
        json(
          summary({
            balances: [
              { currency: "EUR", amountMinor: 742_050, accountCount: 2 },
              { currency: "USD", amountMinor: 120_000, accountCount: 1 },
            ],
            cashflow30d: cashflowFor("EUR", ["EUR", "USD"], EUR_ACTIVITY),
          }),
        ),
      "/api/cashflow": () => json(cashflowFor("USD", ["EUR", "USD"], USD_ACTIVITY)),
    });
    renderHome();

    expect(
      await screen.findByText(
        "Balances are shown per currency: Bursar does not convert between currencies.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /^In, last 30 days/ }).getAttribute("href")).toBe(
      "/transactions?tab=in&currency=EUR",
    );

    const currency = screen.getByRole("group", { name: "Currency" });
    fireEvent.click(within(currency).getByRole("button", { name: "USD" }));

    const usdIn = await screen.findByRole("link", { name: /^In, last 30 days.*1,000\.00/ });
    expect(usdIn.getAttribute("href")).toBe("/transactions?tab=in&currency=USD");
    expect(within(currency).getByRole("button", { name: "USD" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    const cashflowCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.startsWith("/api/cashflow"));
    expect(cashflowCall).toBe("/api/cashflow?currency=USD&from=2026-10-11&to=2026-11-09");
  });

  it("shows an empty state, not the skeleton, when the other currency has no transactions", async () => {
    stubApi({
      "/api/summary": () =>
        json(
          summary({
            balances: [
              { currency: "EUR", amountMinor: 742_050, accountCount: 2 },
              { currency: "USD", amountMinor: 120_000, accountCount: 1 },
            ],
            cashflow30d: cashflowFor("EUR", ["EUR", "USD"], EUR_ACTIVITY),
          }),
        ),
      "/api/cashflow": () => new Response(null, { status: 204 }),
    });
    renderHome();

    const currency = await screen.findByRole("group", { name: "Currency" });
    fireEvent.click(within(currency).getByRole("button", { name: "USD" }));

    expect(await screen.findByText("No transactions in USD in the last 30 days.")).toBeTruthy();
    expect(screen.queryByText("Loading the cash flow…")).toBeNull();
    expect(screen.getByRole("link", { name: /^In, last 30 days/ }).getAttribute("href")).toBe(
      "/transactions?tab=in&currency=USD",
    );
  });
});
