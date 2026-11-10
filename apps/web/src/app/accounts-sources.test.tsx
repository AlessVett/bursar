import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { accountFixture, connectionFixture, DAY, FIXED_NOW } from "../test/accounts-fixtures";
import { stubApi, testQueryClient } from "../test/router";
import { useNavBadges } from "./nav-badges";
import { PALETTE_SOURCES, type PaletteSource } from "./palette-sources";
import { accountDetailPath, routeById } from "./routes";

function wrapper() {
  const client = testQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function serve(connections: ReturnType<typeof connectionFixture>[]) {
  return stubApi({
    "GET /api/connections": () => ({ status: 200, body: { connections, removedAccounts: [] } }),
  });
}

describe("accountDetailPath", () => {
  it("is hidden until the account page ships, then builds the path", () => {
    expect(accountDetailPath(12)).toBeNull();
    const def = routeById("account");
    def.shipped = true;
    try {
      expect(accountDetailPath(12)).toBe("/accounts/12");
    } finally {
      def.shipped = false;
    }
  });
});

describe("useNavBadges", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts the connections that need action as an accent badge on Accounts", async () => {
    serve([
      connectionFixture({ id: 1, status: "active" }),
      connectionFixture({ id: 2, status: "expiring", validUntil: FIXED_NOW + 9 * DAY }),
      connectionFixture({ id: 3, status: "revoked" }),
    ]);
    const { result } = renderHook(() => useNavBadges(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.accounts).toEqual({ count: 2, tone: "accent" }));
  });

  it("shows no badge when every connection is healthy", async () => {
    const fetchMock = serve([connectionFixture({ status: "active" })]);
    const { result } = renderHook(() => useNavBadges(), { wrapper: wrapper() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toEqual({});
  });
});

describe("accounts palette source", () => {
  const found = PALETTE_SOURCES.find((candidate) => candidate.id === "accounts");
  if (!found) throw new Error("The accounts palette source is not registered");
  const source: PaletteSource = found;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const data = [
    connectionFixture({
      id: 1,
      bankName: "Northwind Bank",
      accounts: [
        accountFixture({ id: 1, name: "Household", last4: "3456" }),
        accountFixture({ id: 2, name: "Libretto Esempio", last4: "7890", status: "disabled" }),
      ],
    }),
    connectionFixture({
      id: 2,
      bankName: "Banca Esempio",
      accounts: [accountFixture({ id: 3, name: "Conto Corrente", last4: "1111" })],
    }),
  ];

  it("is registered after the pages source with a limit of six", () => {
    expect(PALETTE_SOURCES.map((candidate) => candidate.id)).toEqual(["pages", "accounts"]);
    expect(source.limit).toBe(6);
    expect(source.minQueryLength).toBe(2);
  });

  it("finds accounts by name, by bank and by the last four IBAN digits", async () => {
    serve(data);
    const byName = renderHook(() => source.useItems("housë"), { wrapper: wrapper() });
    await waitFor(() =>
      expect(byName.result.current.items.map((item) => item.title)).toEqual(["Household"]),
    );
    const item = byName.result.current.items[0];
    expect(item).toMatchObject({
      id: "account:1",
      subtitle: "Northwind Bank",
      group: "Accounts",
      to: "/accounts",
    });
    // UX doc §3 "Mini" form: the 30-day net chip of the account, in its currency.
    expect(isValidElement(item?.trailing)).toBe(true);
    const trailing = item?.trailing as ReactElement<{ netMinor: number; currency: string }>;
    expect(trailing.props).toEqual({
      netMinor: 47_000,
      currency: "EUR",
    });

    const byBank = renderHook(() => source.useItems("NORTHWIND"), { wrapper: wrapper() });
    await waitFor(() => expect(byBank.result.current.items).toHaveLength(2));

    const byDigits = renderHook(() => source.useItems("1111"), { wrapper: wrapper() });
    await waitFor(() =>
      expect(byDigits.result.current.items.map((entry) => entry.title)).toEqual(["Conto Corrente"]),
    );
  });

  it("does not fetch for a query shorter than two characters", async () => {
    const fetchMock = serve(data);
    const { result } = renderHook(() => source.useItems("n"), { wrapper: wrapper() });
    expect(result.current).toEqual({ items: [], loading: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
