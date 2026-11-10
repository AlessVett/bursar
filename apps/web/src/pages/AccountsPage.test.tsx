import type { ConnectionsResponse } from "@bursar/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeById } from "../app/routes";
import { clearToasts } from "../components/feedback";
import { Toaster } from "../components/ui";
import i18n from "../i18n";
import { FormatProvider } from "../lib/format";
import { useUi } from "../store/ui";
import {
  accountFixture,
  connectionFixture,
  DAY,
  FIXED_NOW,
  HOUR,
  removedFixture,
} from "../test/accounts-fixtures";
import { renderRoutes, stubApi } from "../test/router";
import { AccountsPage } from "./AccountsPage";
import { browser } from "./accounts/actions";

type Handler = (body: unknown) => { status: number; body?: unknown };

function scenario(): ConnectionsResponse {
  return {
    connections: [
      connectionFixture({
        id: 1,
        bankName: "Northwind Bank",
        accounts: [
          accountFixture({
            id: 1,
            connectionId: 1,
            name: "Household",
            nickname: "Household",
            bankProduct: "Conto Esempio",
          }),
          accountFixture({
            id: 2,
            connectionId: 1,
            name: "Libretto Esempio",
            bankProduct: "Libretto Esempio",
            status: "disabled",
            iban: null,
            maskedIdentifier: null,
            last4: null,
            balance: null,
            lastSyncedAt: FIXED_NOW - 20 * DAY,
            net30d: { inMinor: 0, outMinor: 0, netMinor: 0 },
          }),
        ],
      }),
      connectionFixture({
        id: 2,
        bankName: "Banca Esempio",
        status: "expiring",
        validUntil: FIXED_NOW + 9 * DAY,
        accounts: [accountFixture({ id: 3, connectionId: 2, name: "Conto Corrente Esempio" })],
      }),
      connectionFixture({
        id: 3,
        bankName: "Harbor Credit",
        status: "expired",
        validUntil: FIXED_NOW - 3 * DAY,
        accounts: [
          accountFixture({
            id: 4,
            connectionId: 3,
            name: "Harbor Current",
            currency: "USD",
            balance: {
              amountMinor: 50_000,
              currency: "USD",
              type: "ITBD",
              asOf: FIXED_NOW,
              referenceDate: "2026-11-09",
            },
            lastSyncedAt: FIXED_NOW - 10 * DAY,
          }),
        ],
      }),
      connectionFixture({
        id: 4,
        bankName: "Lakeside Bank",
        status: "revoked",
        validUntil: FIXED_NOW + 30 * DAY,
        accounts: [accountFixture({ id: 5, connectionId: 4, name: "Lakeside Main" })],
      }),
    ],
    removedAccounts: [
      removedFixture({ id: 9, name: "Old savings", transactionCount: 1234 }),
      removedFixture({ id: 10, name: "Empty card", transactionCount: 0 }),
    ],
  };
}

function serve(extra: Record<string, Handler> = {}, data: ConnectionsResponse = scenario()) {
  return stubApi({ "GET /api/connections": () => ({ status: 200, body: data }), ...extra });
}

function renderPage() {
  return renderRoutes(
    [
      {
        path: "/accounts",
        element: (
          <FormatProvider timeZone="Europe/Rome">
            <AccountsPage />
            <Toaster />
          </FormatProvider>
        ),
      },
    ],
    { initialEntries: ["/accounts"] },
  );
}

function called(fetchMock: ReturnType<typeof stubApi>, method: string, path: string): boolean {
  return fetchMock.mock.calls.some(
    ([url, init]) => String(url) === path && init?.method === method,
  );
}

function dialogOf(title: string): HTMLElement {
  const dialog = screen.getByText(title).closest('[role="dialog"], [role="alertdialog"]');
  if (!(dialog instanceof HTMLElement)) throw new Error(`No dialog titled ${title}`);
  return dialog;
}

async function region(name: string): Promise<HTMLElement> {
  return screen.findByRole("region", { name });
}

async function openMenu(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name }));
}

describe("AccountsPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    useUi.setState({ privacy: false });
    clearToasts();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("draws the 30-day mini strip only on rows with recent transactions", async () => {
    const day = (date: string, inMinor: number, outMinor: number) => ({
      date,
      end: date,
      inMinor,
      outMinor,
      netMinor: inMinor - outMinor,
      count: 1,
      balanceMinor: null,
    });
    serve(
      {},
      {
        connections: [
          connectionFixture({
            bankName: "Northwind Bank",
            accounts: [
              accountFixture({
                id: 1,
                name: "Busy account",
                daily30d: [day("2026-11-08", 0, 4_250), day("2026-11-09", 120_000, 0)],
              }),
              accountFixture({ id: 2, name: "Quiet account", daily30d: [] }),
            ],
          }),
        ],
        removedAccounts: [],
      },
    );
    renderPage();
    const bank = await region("Northwind Bank");
    const summaries = within(bank).getAllByText(/^Daily cash flow, last 30 days/);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.closest("li")?.textContent).toContain("Busy account");
  });

  it("groups accounts by bank, broken connections first, with status and consent chips", async () => {
    serve();
    renderPage();
    const headings = await screen.findAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Harbor Credit",
      "Lakeside Bank",
      "Banca Esempio",
      "Northwind Bank",
      "Disconnected accounts",
    ]);
    expect(screen.getByRole("heading", { level: 1 }).parentElement?.textContent).toBe("Accounts5");

    expect(screen.getByRole("link", { name: "Connect a bank" }).getAttribute("href")).toBe(
      "/connect",
    );
    const harbor = await region("Harbor Credit");
    expect(within(harbor).getByText("Expired")).toBeTruthy();
    expect(within(harbor).getByText("Consent expired 3 days ago")).toBeTruthy();
    expect(within(harbor).getByRole("button", { name: "Renew consent" })).toBeTruthy();
    expect(within(harbor).getByText(/500\.00/)).toBeTruthy();
    expect(within(harbor).getByText("Updated 10 days ago")).toBeTruthy();

    const lakeside = await region("Lakeside Bank");
    expect(within(lakeside).getByText("Revoked")).toBeTruthy();
    expect(within(lakeside).queryByText(/^Consent expire/)).toBeNull();

    const banca = await region("Banca Esempio");
    expect(within(banca).getByText("Expiring soon")).toBeTruthy();
    expect(within(banca).getByText("Consent expires in 9 days")).toBeTruthy();
    expect(within(banca).getByRole("button", { name: "Renew consent" })).toBeTruthy();

    const northwind = await region("Northwind Bank");
    expect(within(northwind).getByText("Active")).toBeTruthy();
    expect(within(northwind).getByText("Consent expires in 60 days")).toBeTruthy();
    expect(within(northwind).getByRole("button", { name: "Sync account" })).toBeTruthy();
    expect(within(northwind).getByText("Household")).toBeTruthy();
    expect(within(northwind).getByText("Conto Esempio")).toBeTruthy();
    expect(within(northwind).getByText("IT60 •••• •••• 3456")).toBeTruthy();
    expect(within(northwind).getByText(/1,234\.50/)).toBeTruthy();
    expect(within(northwind).getByText("Updated 3 hours ago")).toBeTruthy();
    expect(within(northwind).getByText("Disabled")).toBeTruthy();
    expect(within(northwind).queryByText(/Updated 20 days ago/)).toBeNull();
    expect(within(northwind).getByText("No balance yet")).toBeTruthy();
  });

  it("shows a consent chip without a date when the bank ended a consent that has not run out", async () => {
    serve(
      {},
      {
        connections: [
          connectionFixture({
            status: "expired",
            validUntil: FIXED_NOW + 20 * DAY,
            accounts: [accountFixture()],
          }),
        ],
        removedAccounts: [],
      },
    );
    renderPage();
    expect(await screen.findByText("Consent ended")).toBeTruthy();
  });

  it("links to the account page and hides the link and menu item when the page is not shipped", async () => {
    serve();
    const view = renderPage();
    const shipped = await region("Northwind Bank");
    const link = within(shipped).getByRole("link", { name: "Household" });
    expect(link.getAttribute("href")).toBe("/accounts/1");
    await openMenu("Actions for Household");
    expect(await screen.findByRole("menuitem", { name: /Open details/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    view.unmount();

    const def = routeById("account");
    def.shipped = false;
    try {
      renderPage();
      const hidden = await region("Northwind Bank");
      expect(within(hidden).queryByRole("link", { name: "Household" })).toBeNull();
      await openMenu("Actions for Household");
      expect(screen.queryByRole("menuitem", { name: /Open details/ })).toBeNull();
    } finally {
      def.shipped = true;
    }
  });

  it("renames an account inline and confirms with a toast", async () => {
    const patches: unknown[] = [];
    serve({
      "PATCH /api/accounts/1": (body) => {
        patches.push(body);
        return {
          status: 200,
          body: accountFixture({ id: 1, name: "Everyday", nickname: "Everyday" }),
        };
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Household" }));
    const input = screen.getByRole("textbox", { name: "Account name" });
    fireEvent.change(input, { target: { value: "  Everyday " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Account renamed")).toBeTruthy();
    expect(screen.getByText("“Everyday” is now the name shown across Bursar.")).toBeTruthy();
    expect(patches).toEqual([{ nickname: "Everyday" }]);
  });

  it("resets the name when the field is emptied", async () => {
    const patches: unknown[] = [];
    serve({
      "PATCH /api/accounts/1": (body) => {
        patches.push(body);
        return { status: 200, body: accountFixture({ id: 1, name: "Conto Esempio" }) };
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Household" }));
    const input = screen.getByRole("textbox", { name: "Account name" });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("The default name is shown again.")).toBeTruthy();
    expect(patches).toEqual([{ nickname: null }]);
  });

  it("asks before disabling an account and says it can be undone", async () => {
    const patches: unknown[] = [];
    serve({
      "PATCH /api/accounts/1": (body) => {
        patches.push(body);
        return {
          status: 200,
          body: accountFixture({ id: 1, name: "Household", status: "disabled" }),
        };
      },
    });
    renderPage();
    await openMenu("Actions for Household");
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Disable account/ }));
    const dialog = dialogOf("Disable Household?");
    expect(within(dialog).getByText(/you can enable it again at any time/)).toBeTruthy();
    expect(patches).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, disable" }));
    expect(await screen.findByText("Account disabled")).toBeTruthy();
    expect(
      screen.getByText(/Household no longer syncs and is left out of the totals/),
    ).toBeTruthy();
    expect(patches).toEqual([{ status: "disabled" }]);
    await waitFor(() => expect(screen.queryByText("Disable Household?")).toBeNull());
  });

  it("enables a disabled account at once, without a dialog", async () => {
    const patches: unknown[] = [];
    serve({
      "PATCH /api/accounts/2": (body) => {
        patches.push(body);
        return { status: 200, body: accountFixture({ id: 2, name: "Libretto Esempio" }) };
      },
    });
    renderPage();
    await openMenu("Actions for Libretto Esempio");
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Enable account/ }));
    expect(await screen.findByText("Account enabled")).toBeTruthy();
    expect(patches).toEqual([{ status: "active" }]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("explains why a sync is blocked instead of hiding the action", async () => {
    serve();
    renderPage();
    await openMenu("Actions for Harbor Credit");
    const item = await screen.findByRole("menuitem", { name: /^Sync account/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("The consent has ended. Renew it to sync again.");
  });

  it("shows the removal counts before disconnecting and confirms with a toast", async () => {
    const fetchMock = serve({
      "GET /api/connections/1/removal-preview": () => ({
        status: 200,
        body: { bankName: "Northwind Bank", accounts: 2, transactions: 1234 },
      }),
      "DELETE /api/connections/1": () => ({ status: 200, body: { removedAccounts: 2 } }),
    });
    renderPage();
    await openMenu("Actions for Northwind Bank");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect bank" }));
    const dialog = dialogOf("Disconnect Northwind Bank?");
    const confirm = within(dialog).getByRole("button", { name: "Yes, disconnect" });
    expect(await within(dialog).findByText(/2 accounts move to/)).toBeTruthy();
    expect(within(dialog).getByText(/1,234 transactions stay in Bursar/)).toBeTruthy();
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    expect(await screen.findByText("Bank disconnected")).toBeTruthy();
    expect(called(fetchMock, "DELETE", "/api/connections/1")).toBe(true);
    await waitFor(() => expect(screen.queryByText("Disconnect Northwind Bank?")).toBeNull());
  });

  it("keeps the disconnect button disabled until the preview has loaded", async () => {
    serve({
      "GET /api/connections/1/removal-preview": () => ({
        status: 500,
        body: { error: "boom" },
      }),
    });
    renderPage();
    await openMenu("Actions for Northwind Bank");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect bank" }));
    const dialog = dialogOf("Disconnect Northwind Bank?");
    expect(await within(dialog).findByText(/could not be worked out/)).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Yes, disconnect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("lists disconnected accounts and purges one with its real count", async () => {
    const bodies: unknown[] = [];
    serve({
      "POST /api/accounts/9/purge": (body) => {
        bodies.push(body);
        return { status: 200, body: { transactions: 1234, balances: 3 } };
      },
    });
    renderPage();
    const section = await region("Disconnected accounts");
    expect(within(section).getByText("Old savings")).toBeTruthy();
    expect(within(section).getByText("1,234 transactions")).toBeTruthy();
    expect(within(section).getByText("0 transactions")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Purge transactions" }));
    const dialog = dialogOf("Purge the transactions of Old savings?");
    expect(
      within(dialog).getByText(/1,234 transactions, the balances and the sync history/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, purge 1,234 transactions" }));
    expect(await screen.findByText("Transactions purged")).toBeTruthy();
    expect(bodies).toEqual([{ confirm: true }]);
  });

  it("removes a disconnected account that has no transactions left", async () => {
    serve({
      "POST /api/accounts/10/purge": () => ({
        status: 200,
        body: { transactions: 0, balances: 1 },
      }),
    });
    renderPage();
    const section = await region("Disconnected accounts");
    fireEvent.click(within(section).getByRole("button", { name: "Remove account" }));
    const dialog = dialogOf("Remove Empty card?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, remove account" }));
    expect(await screen.findByText("Account removed")).toBeTruthy();
  });

  it("queues a sync for a connection and tells the owner what happens next", async () => {
    const fetchMock = serve({
      "POST /api/connections/1/sync": () => ({ status: 202, body: { queued: 1 } }),
    });
    renderPage();
    const northwind = await region("Northwind Bank");
    fireEvent.click(within(northwind).getByRole("button", { name: "Sync account" }));
    expect(await screen.findByText("Sync started")).toBeTruthy();
    expect(screen.getByText(/Reading 1 account at Northwind Bank/)).toBeTruthy();
    expect(called(fetchMock, "POST", "/api/connections/1/sync")).toBe(true);
  });

  it("turns a 409 sync_in_progress into a warning toast", async () => {
    serve({
      "POST /api/connections/1/sync": () => ({
        status: 409,
        body: { error: "A sync is already running", code: "sync_in_progress" },
      }),
    });
    renderPage();
    const northwind = await region("Northwind Bank");
    fireEvent.click(within(northwind).getByRole("button", { name: "Sync account" }));
    expect(await screen.findByText("Sync could not be started")).toBeTruthy();
    expect(screen.getByText("A sync is already running.")).toBeTruthy();
  });

  it("explains a rate limit with the time to retry", async () => {
    serve({
      "POST /api/accounts/3/sync": () => ({
        status: 409,
        body: { error: "Rate limited", code: "rate_limited", retryAt: FIXED_NOW + 5 * HOUR },
      }),
    });
    renderPage();
    await openMenu("Actions for Conto Corrente Esempio");
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Sync now/ }));
    expect(
      await screen.findByText("The bank is limiting requests for now. Try again in 5 hours."),
    ).toBeTruthy();
  });

  it("explains an inactive connection when the server refuses the sync", async () => {
    serve({
      "POST /api/accounts/3/sync": () => ({
        status: 409,
        body: { error: "Connection inactive", code: "connection_inactive" },
      }),
    });
    renderPage();
    await openMenu("Actions for Conto Corrente Esempio");
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Sync now/ }));
    expect(
      await screen.findByText("The consent has ended. Renew it with your bank before syncing."),
    ).toBeTruthy();
  });

  it("renews a consent by redirecting to the bank", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    serve({
      "POST /api/connections/2/renew": () => ({
        status: 200,
        body: { redirectUrl: "https://bank.example.test/authorize?x=1" },
      }),
    });
    renderPage();
    const banca = await region("Banca Esempio");
    const renew = within(banca).getByRole("button", { name: "Renew consent" });
    expect(renew.getAttribute("data-qa-skip")).not.toBeNull();
    fireEvent.click(renew);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://bank.example.test/authorize?x=1"),
    );
  });

  it("refuses to follow a redirect that is not http or https", async () => {
    const assign = vi.spyOn(browser, "assign").mockImplementation(() => undefined);
    serve({
      "POST /api/connections/2/renew": () => ({
        status: 200,
        body: { redirectUrl: "javascript:alert(1)" },
      }),
    });
    renderPage();
    const banca = await region("Banca Esempio");
    fireEvent.click(within(banca).getByRole("button", { name: "Renew consent" }));
    expect(await screen.findByText("Consent could not be renewed")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("points to the docs when banking is not configured", async () => {
    serve({
      "POST /api/connections/2/renew": () => ({
        status: 503,
        body: { error: "Banking is not configured", code: "banking_not_configured" },
      }),
    });
    renderPage();
    const banca = await region("Banca Esempio");
    fireEvent.click(within(banca).getByRole("button", { name: "Renew consent" }));
    expect(await screen.findByText(/docs\/enable-banking\.md/)).toBeTruthy();
  });

  it("explains that Bursar only reads data when no bank is connected", async () => {
    serve({}, { connections: [], removedAccounts: [] });
    renderPage();
    expect(await screen.findByText("No bank connected yet")).toBeTruthy();
    expect(screen.getByText(/only reads balances and transactions from your bank/)).toBeTruthy();
    expect(screen.getByText(/cannot make payments or move money/)).toBeTruthy();
    const connectLinks = screen.getAllByRole("link", { name: "Connect a bank" });
    expect(connectLinks).toHaveLength(2);
    expect(connectLinks[0]?.getAttribute("href")).toBe("/connect");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("still lists disconnected accounts when no connection is left", async () => {
    serve({}, { connections: [], removedAccounts: [removedFixture()] });
    renderPage();
    expect(await screen.findByText("No active connections")).toBeTruthy();
    expect(await region("Disconnected accounts")).toBeTruthy();
  });

  it("shows an error state with a retry, never invented data", async () => {
    let calls = 0;
    stubApi({
      "GET /api/connections": () =>
        ++calls === 1
          ? { status: 500, body: { error: "boom" } }
          : { status: 200, body: scenario() },
    });
    renderPage();
    expect(await screen.findByText("Accounts could not be loaded")).toBeTruthy();
    expect(screen.queryByText("Northwind Bank")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await region("Northwind Bank")).toBeTruthy();
  });

  it("celebrates when every account was updated today", async () => {
    serve(
      {},
      { connections: [connectionFixture({ accounts: [accountFixture()] })], removedAccounts: [] },
    );
    renderPage();
    expect(await screen.findByText("All good: every account was updated today.")).toBeTruthy();
  });

  it("does not say all is good while something needs attention", async () => {
    serve();
    renderPage();
    await region("Northwind Bank");
    expect(screen.queryByText("All good: every account was updated today.")).toBeNull();
  });

  it("shows the progress of a running sync and a failed last sync", async () => {
    serve(
      {},
      {
        connections: [
          connectionFixture({
            accounts: [
              accountFixture({ id: 1, name: "Running", syncInProgress: true }),
              accountFixture({
                id: 2,
                name: "Failing",
                lastSyncedAt: FIXED_NOW - 2 * DAY,
                lastSyncError: { code: "ASPSP_ERROR", at: FIXED_NOW - HOUR },
              }),
            ],
          }),
        ],
        removedAccounts: [],
      },
    );
    renderPage();
    expect(await screen.findByText("Syncing…")).toBeTruthy();
    expect(screen.getByText("Last sync failed")).toBeTruthy();
    await openMenu("Actions for Running");
    const item = await screen.findByRole("menuitem", { name: /^Sync now/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("falls back to initials when a logo cannot be loaded", async () => {
    serve(
      {},
      {
        connections: [connectionFixture({ hasLogo: true, bankName: "Banca Esempio" })],
        removedAccounts: [],
      },
    );
    renderPage();
    const section = await region("Banca Esempio");
    const image = section.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/api/banks/logo?country=IT&name=Banca+Esempio");
    if (image) fireEvent.error(image);
    await waitFor(() => expect(section.querySelector("img")).toBeNull());
    expect(within(section).getByText("BE")).toBeTruthy();
  });

  it("masks amounts and IBAN digits in privacy mode", async () => {
    useUi.setState({ privacy: true });
    serve();
    renderPage();
    const northwind = await region("Northwind Bank");
    expect(within(northwind).queryByText(/1,234\.50/)).toBeNull();
    expect(within(northwind).queryByText("IT60 •••• •••• 3456")).toBeNull();
    expect(within(northwind).getAllByRole("img", { name: "Amount hidden" }).length).toBeGreaterThan(
      0,
    );
    expect(
      within(northwind).getAllByRole("img", { name: "IBAN hidden by privacy mode" }).length,
    ).toBeGreaterThan(0);
  });

  it("renders in Italian", async () => {
    await i18n.changeLanguage("it");
    serve();
    renderPage();
    const banca = await region("Banca Esempio");
    expect(within(banca).getByText("Il consenso scade tra 9 giorni")).toBeTruthy();
    expect(within(banca).getByRole("button", { name: "Rinnova il consenso" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Conti scollegati" })).toBeTruthy();
  });
});
