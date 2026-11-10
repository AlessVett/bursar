import type { TransactionDetail } from "@bursar/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { FormatProvider } from "../../lib/format";
import { useUi } from "../../store/ui";
import { renderRoutes } from "../../test/router";
import { TransactionDrawer } from "./TransactionDrawer";

const DETAIL: TransactionDetail = {
  id: 101,
  accountId: 1,
  accountName: "Conto corrente",
  status: "booked",
  date: "2026-11-06",
  bookingDate: "2026-11-06",
  valueDate: "2026-11-05",
  amountMinor: -4210,
  currency: "EUR",
  counterparty: "Caffè Centrale",
  description: "Card payment 4021",
  transactionDate: "2026-11-04",
  providerReference: "REF-2026-000101",
  counterpartyAccount: "IT60 •••• •••• 1234",
  remittanceLines: ["Order 2026/118", "Table 4"],
  bankCode: { code: "PMNT", subCode: "CCRD", description: "Card payment" },
  merchantCategoryCode: "5814",
  balanceAfter: { amountMinor: 152300, currency: "EUR" },
  firstSeenAt: Date.UTC(2026, 10, 6, 9, 30),
  lastSeenAt: Date.UTC(2026, 10, 8, 9, 30),
  bankName: "Banca Esempio",
};

type Reply = { status: number; body: unknown };

function stubDetail(reply: () => Reply) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const result = url.pathname.startsWith("/api/transactions/")
      ? reply()
      : { status: 404, body: { error: "Not found" } };
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDrawer(id: number | null, onClose: () => void = vi.fn()) {
  return renderRoutes([
    {
      path: "/",
      element: (
        <FormatProvider timeZone="Europe/Rome">
          <TransactionDrawer id={id} onClose={onClose} />
        </FormatProvider>
      ),
    },
  ]);
}

describe("TransactionDrawer", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useUi.setState({ privacy: false });
  });

  it("shows every detail of the transaction, the bank reference included", async () => {
    const fetchMock = stubDetail(() => ({ status: 200, body: DETAIL }));
    renderDrawer(101);
    const dialog = await screen.findByRole("dialog", { name: "Transaction" });
    expect(await within(dialog).findByText("REF-2026-000101")).toBeTruthy();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain("/api/transactions/101");
    expect(within(dialog).getByText("-€42.10")).toBeTruthy();
    expect(within(dialog).getByText("Booked")).toBeTruthy();
    expect(within(dialog).getByText("Caffè Centrale")).toBeTruthy();
    expect(within(dialog).getByText("Card payment 4021")).toBeTruthy();
    expect(within(dialog).getByText("6 November 2026")).toBeTruthy();
    expect(within(dialog).getByText("5 November 2026")).toBeTruthy();
    expect(within(dialog).getByText("4 November 2026")).toBeTruthy();
    expect(within(dialog).getByText("IT60 •••• •••• 1234")).toBeTruthy();
    expect(within(dialog).getByText("Conto corrente · Banca Esempio")).toBeTruthy();
    expect(within(dialog).getByText("Card payment (PMNT · CCRD)")).toBeTruthy();
    expect(within(dialog).getByText("5814")).toBeTruthy();
    expect(within(dialog).getByText("€1,523.00")).toBeTruthy();
    expect(within(dialog).getByText("Order 2026/118")).toBeTruthy();
    expect(within(dialog).getByText("Table 4")).toBeTruthy();
    expect(within(dialog).getByText("First seen")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Copy bank reference" })).toBeTruthy();
    expect(within(dialog).queryByText(/pending/i)).toBeNull();
  });

  it("links to the account and closes from the close button", async () => {
    stubDetail(() => ({ status: 200, body: DETAIL }));
    const onClose = vi.fn();
    renderDrawer(101, onClose);
    const dialog = await screen.findByRole("dialog", { name: "Transaction" });
    const link = await within(dialog).findByRole("link", { name: "Open account" });
    expect(link.getAttribute("href")).toBe("/accounts/1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("explains that a pending transaction may still change", async () => {
    stubDetail(() => ({
      status: 200,
      body: { ...DETAIL, status: "pending", bookingDate: null, providerReference: null },
    }));
    renderDrawer(101);
    const dialog = await screen.findByRole("dialog", { name: "Transaction" });
    expect(
      await within(dialog).findByText(
        "The bank has not booked this transaction yet: its amount and date may still change.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("Pending")).toBeTruthy();
    expect(within(dialog).queryByText("Booking date")).toBeNull();
    expect(within(dialog).queryByText("Bank reference")).toBeNull();
  });

  it("shows an inline not-found state without the id", async () => {
    stubDetail(() => ({ status: 404, body: { error: "Not found", code: "not_found" } }));
    renderDrawer(999);
    const dialog = await screen.findByRole("dialog", { name: "Transaction" });
    expect(
      await within(dialog).findByText("This transaction does not exist or was removed"),
    ).toBeTruthy();
    expect(dialog.textContent).not.toContain("999");
    expect(within(dialog).queryByRole("link", { name: "Open account" })).toBeNull();
  });

  it("offers a retry after a server error", async () => {
    let failing = true;
    stubDetail(() =>
      failing ? { status: 500, body: { error: "Internal error" } } : { status: 200, body: DETAIL },
    );
    renderDrawer(101);
    const dialog = await screen.findByRole("dialog", { name: "Transaction" });
    expect(await within(dialog).findByText("The transaction could not be loaded")).toBeTruthy();
    failing = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("REF-2026-000101")).toBeTruthy();
  });

  it("masks the amount, the balance and the IBAN digits in privacy mode", async () => {
    useUi.setState({ privacy: true });
    stubDetail(() => ({ status: 200, body: DETAIL }));
    renderDrawer(101);
    const dialog = await screen.findByRole("dialog", { name: "Transaction" });
    await within(dialog).findByText("REF-2026-000101");
    await waitFor(() => expect(dialog.textContent).not.toContain("42.10"));
    expect(dialog.textContent).not.toContain("1,523.00");
    expect(dialog.textContent).not.toContain("1234");
    expect(within(dialog).getAllByRole("img", { name: "Amount hidden" })).toHaveLength(2);
  });
});
