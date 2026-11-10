import type { SearchResponse } from "@bursar/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { renderRoutes, stubApi } from "../test/router";
import { CommandPalette, PaletteProvider, usePaletteControl } from "./CommandPalette";

// Every registry route counts as shipped here, so the palette has more than 8 pages to offer.
vi.mock("./routes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./routes")>();
  return {
    ...actual,
    shippedRoutes: () => actual.ROUTES.map((def) => ({ ...def, shipped: true })),
  };
});

function OpenOnMount() {
  const { open } = usePaletteControl();
  useEffect(() => open(), [open]);
  return null;
}

function renderPalette() {
  const element = (
    <PaletteProvider>
      <OpenOnMount />
      <CommandPalette />
    </PaletteProvider>
  );
  // One layout route stays mounted across navigations, like the AppShell.
  return renderRoutes([
    {
      path: "/",
      element,
      children: [
        { index: true, element: null },
        { path: "*", element: null },
      ],
    },
  ]);
}

function input(): HTMLInputElement {
  return screen.getByRole("combobox") as HTMLInputElement;
}

function optionTitles(): string[] {
  return screen
    .queryAllByRole("option")
    .map((option) => option.querySelector("span span")?.textContent ?? "");
}

function stubTransactionSearch(transactions: SearchResponse["transactions"]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const found = url.pathname === "/api/search";
    return new Response(
      JSON.stringify(found ? { accounts: [], transactions } : { error: "Not found" }),
      { status: found ? 200 : 404, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("CommandPalette", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubApi({
      "GET /api/connections": () => ({
        status: 200,
        body: { connections: [], removedAccounts: [] },
      }),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows 8 pages with descriptions as subtitles when the query is empty", () => {
    vi.useFakeTimers();
    renderPalette();
    act(() => vi.advanceTimersByTime(30));
    expect(document.activeElement).toBe(input());
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(screen.queryByText("/transactions")).toBeNull();
    expect(screen.getByText("Every inflow and outflow across your accounts")).toBeTruthy();
    expect(screen.getByText("↑↓ navigate · ↵ open · esc close · 8 results")).toBeTruthy();
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("matches without regard to accents or case and never lists pages that need a parameter", () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: "TRÀNSACTIONS" } });
    expect(optionTitles()).toEqual(["Transactions"]);
    fireEvent.change(input(), { target: { value: "detail balance" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("moves the active option with the arrow keys and opens it with Enter", async () => {
    const { router } = renderPalette();
    const field = input();
    expect(field.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]?.id);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    const third = screen.getAllByRole("option")[2];
    expect(third?.getAttribute("aria-selected")).toBe("true");
    expect(field.getAttribute("aria-activedescendant")).toBe(third?.id);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[7]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.change(field, { target: { value: "settings" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("shows the empty text with typographic quotes and closes on Escape", async () => {
    stubTransactionSearch([]);
    renderPalette();
    fireEvent.change(input(), { target: { value: "xyz" } });
    expect(await screen.findByText("No results for “xyz”")).toBeTruthy();
    expect(screen.getByText("Try a name, a bank or the last digits of an IBAN.")).toBeTruthy();
    expect(screen.getByText("↑↓ navigate · ↵ open · esc close · 0 results")).toBeTruthy();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses the Italian texts", async () => {
    await i18n.changeLanguage("it");
    renderPalette();
    fireEvent.change(input(), { target: { value: "attivita" } });
    expect(optionTitles()).toEqual(["Attività"]);
    expect(screen.getByText("↑↓ naviga · ↵ apri · esc chiudi · 1 risultato")).toBeTruthy();
  });

  it("finds transactions by counterparty through the search API and opens the drawer link", async () => {
    const fetchMock = stubTransactionSearch([
      {
        id: 55,
        counterparty: "Caffè Centrale",
        date: "2026-11-07",
        amountMinor: -350,
        currency: "EUR",
        accountName: "Conto corrente",
      },
    ]);
    const { router } = renderPalette();
    fireEvent.change(input(), { target: { value: "c" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/search"))).toBe(false);
    fireEvent.change(input(), { target: { value: "Caffè" } });
    const option = await screen.findByRole("option", { name: /Caffè Centrale/ });
    expect(option.textContent).toContain("Conto corrente · 7 Nov 2026");
    expect(option.textContent).not.toContain("3.50");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain("/api/search?q=caffe");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() =>
      expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(
        "/transactions?tx=55",
      ),
    );
  });
});
