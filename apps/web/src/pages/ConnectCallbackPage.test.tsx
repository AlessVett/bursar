import type { CompleteConnectionResponse } from "@bursar/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { stubApi, testQueryClient } from "../test/router";
import { ConnectCallbackPage } from "./ConnectCallbackPage";

const STATE = "s-3f9a1c7e5b2d4a60-abcdef";
const COMPLETE = "POST /api/connections/complete";

function response(overrides: Partial<CompleteConnectionResponse>): CompleteConnectionResponse {
  return {
    outcome: "connected",
    connectionId: 7,
    bankName: "Northwind Bank",
    accounts: [],
    errorCode: null,
    ...overrides,
  };
}

const ONE_ACCOUNT = [
  {
    id: 1,
    name: "Northwind Current",
    maskedIdentifier: "IT60 •••• •••• 1234",
    currency: "EUR",
    status: "active" as const,
  },
];

function renderCallback(search: string, options: { strict?: boolean } = {}) {
  window.history.replaceState(null, "", `/connect/callback${search}`);
  const router = createMemoryRouter(
    [
      { path: "/connect/callback", element: <ConnectCallbackPage /> },
      { path: "/connect", element: <p>Connect page</p> },
      { path: "/accounts", element: <p>Accounts page</p> },
    ],
    { initialEntries: ["/connect/callback"] },
  );
  const tree = (
    <QueryClientProvider client={testQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

function completeCalls(fetchMock: ReturnType<typeof stubApi>) {
  return fetchMock.mock.calls.filter(([input]) => input === "/api/connections/complete");
}

describe("ConnectCallbackPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("completes a new connection, lists the accounts and strips the parameters", async () => {
    const fetchMock = stubApi({
      [COMPLETE]: () => ({ status: 200, body: response({ accounts: ONE_ACCOUNT }) }),
    });
    renderCallback(`?state=${STATE}&code=fake-1`);
    await screen.findByRole("heading", { name: "Bank connected" });
    expect(screen.getByText("1 account found")).toBeTruthy();
    expect(screen.getByText("Northwind Current")).toBeTruthy();
    expect(screen.getByText("IT60 •••• •••• 1234")).toBeTruthy();
    expect(screen.getByText("EUR")).toBeTruthy();
    expect(
      screen.getByText("Initial sync started: transactions appear in a few minutes."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open accounts" }).getAttribute("href")).toBe(
      "/accounts",
    );
    expect(document.querySelector('[data-outcome="connected"]')).not.toBeNull();
    expect(window.location.search).toBe("");
    const calls = completeCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ state: STATE, code: "fake-1" });
  });

  it("shows a renewed consent", async () => {
    stubApi({
      [COMPLETE]: () => ({
        status: 200,
        body: response({ outcome: "renewed", accounts: ONE_ACCOUNT }),
      }),
    });
    renderCallback(`?state=${STATE}&code=fake-2`);
    await screen.findByRole("heading", { name: "Consent renewed" });
  });

  it("gives restricted-mode guidance when the bank shared no accounts", async () => {
    stubApi({ [COMPLETE]: () => ({ status: 200, body: response({ outcome: "no_accounts" }) }) });
    renderCallback(`?state=${STATE}&code=fake-empty-1`);
    await screen.findByRole("heading", { name: "No accounts were shared" });
    expect(screen.getByText(/Open the Enable Banking Control Panel/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/connect");
  });

  it("reports a cancelled authorisation and sends the error to the server", async () => {
    const fetchMock = stubApi({
      [COMPLETE]: () => ({ status: 200, body: response({ outcome: "denied" }) }),
    });
    renderCallback(`?error=access_denied&error_description=Cancelled%20by%20user&state=${STATE}`);
    await screen.findByRole("heading", { name: "You cancelled at the bank" });
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/connect");
    expect(JSON.parse(String(completeCalls(fetchMock)[0]?.[1]?.body))).toEqual({
      state: STATE,
      error: "access_denied",
      errorDescription: "Cancelled by user",
    });
  });

  it("translates a known failure code", async () => {
    stubApi({
      [COMPLETE]: () => ({
        status: 200,
        body: response({ outcome: "failed", errorCode: "EXPIRED_AUTHORIZATION_CODE" }),
      }),
    });
    renderCallback(`?state=${STATE}&code=fake-3`);
    await screen.findByRole("heading", { name: "The bank could not be connected" });
    expect(screen.getByText(/authorisation code from the bank expired/)).toBeTruthy();
  });

  it("shows a generic sentence for an unknown failure code and never the raw code", async () => {
    stubApi({
      [COMPLETE]: () => ({
        status: 200,
        body: response({ outcome: "failed", errorCode: "server_error" }),
      }),
    });
    renderCallback(`?state=${STATE}&error=server_error`);
    await screen.findByText(/The bank reported an error/);
    expect(screen.queryByText(/server_error/)).toBeNull();
  });

  it("explains an expired or already used link on 410", async () => {
    stubApi({
      [COMPLETE]: () => ({
        status: 410,
        body: { error: "Invalid state", code: "state_invalid" },
      }),
    });
    renderCallback(`?state=${STATE}&code=fake-4`);
    await screen.findByRole("heading", { name: "This link has expired or was already used" });
    expect(screen.getByRole("link", { name: "Start again" }).getAttribute("href")).toBe("/connect");
    expect(document.querySelector('[data-outcome="state_invalid"]')).not.toBeNull();
  });

  it("explains that banking is not configured on 503", async () => {
    stubApi({
      [COMPLETE]: () => ({
        status: 503,
        body: { error: "Banking is not configured", code: "banking_not_configured" },
      }),
    });
    renderCallback(`?state=${STATE}&code=fake-5`);
    await screen.findByRole("heading", { name: "Bank connections are not set up" });
  });

  it("shows a generic error for any other failure", async () => {
    stubApi({ [COMPLETE]: () => ({ status: 500, body: { error: "Internal error" } }) });
    renderCallback(`?state=${STATE}&code=fake-6`);
    await screen.findByRole("heading", { name: "The connection could not be completed" });
    expect(screen.getByRole("link", { name: "Start again" })).toBeTruthy();
  });

  it("does not call the server when there is nothing to complete", async () => {
    const fetchMock = stubApi({});
    renderCallback("");
    await screen.findByRole("heading", { name: "There is no bank response to complete" });
    expect(screen.getByRole("link", { name: "Connect a bank" }).getAttribute("href")).toBe(
      "/connect",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a state that is too short as missing", async () => {
    const fetchMock = stubApi({});
    renderCallback("?state=short&code=fake-7");
    await screen.findByRole("heading", { name: "There is no bank response to complete" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits exactly once under StrictMode", async () => {
    const fetchMock = stubApi({
      [COMPLETE]: () => ({ status: 200, body: response({ accounts: ONE_ACCOUNT }) }),
    });
    renderCallback(`?state=${STATE}&code=fake-8`, { strict: true });
    await screen.findByRole("heading", { name: "Bank connected" });
    expect(completeCalls(fetchMock)).toHaveLength(1);
    expect(window.location.search).toBe("");
  });

  it("puts the parameters back when the session expired, so login can resume", async () => {
    stubApi({ [COMPLETE]: () => ({ status: 401, body: { error: "Unauthorized" } }) });
    renderCallback(`?state=${STATE}&code=fake-9`);
    await waitFor(() => expect(window.location.search).toBe(`?state=${STATE}&code=fake-9`));
  });
});
