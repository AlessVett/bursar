import {
  type AspspListResponse,
  type BankStatusResponse,
  SETTINGS_DEFAULTS,
  type SettingsResponse,
} from "@bursar/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedback } from "../components/feedback";
import i18n from "../i18n";
import { renderRoutes, stubApi } from "../test/router";
import { ConnectPage } from "./ConnectPage";
import { ConnectBankButton } from "./connect/ConnectBankButton";

vi.mock("../components/feedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/feedback")>();
  return { ...actual, feedback: vi.fn() };
});

type Handler = (body: unknown) => { status: number; body?: unknown };

const STATUS_OK: BankStatusResponse = {
  configured: true,
  environment: "SANDBOX",
  active: true,
  redirectUrlAllowed: true,
  countries: ["IT", "DE", "FI"],
  error: null,
};

const BANKS: AspspListResponse = {
  aspsps: [
    { name: "Banca Esempio", country: "IT", maximumConsentDays: 180, beta: false, hasLogo: false },
    { name: "Banca Perù", country: "IT", maximumConsentDays: 365, beta: false, hasLogo: false },
    { name: "Northwind Bank", country: "IT", maximumConsentDays: 90, beta: true, hasLogo: false },
  ],
};

function settingsResponse(overrides: Partial<SettingsResponse["values"]> = {}): SettingsResponse {
  return {
    values: { ...SETTINGS_DEFAULTS, country: "IT", ...overrides },
    system: {
      timezone: "Europe/Rome",
      publicUrl: "https://bursar.example.test",
      enableBankingConfigured: true,
      smtpConfigured: false,
      backupTarget: "local",
    },
  };
}

function handlers(
  extra: Record<string, Handler> = {},
  options: {
    status?: BankStatusResponse;
    settings?: SettingsResponse;
    banks?: AspspListResponse;
  } = {},
): Record<string, Handler> {
  return {
    "GET /api/banks/status": () => ({ status: 200, body: options.status ?? STATUS_OK }),
    "GET /api/settings": () => ({ status: 200, body: options.settings ?? settingsResponse() }),
    "GET /api/banks/aspsps?country=IT": () => ({ status: 200, body: options.banks ?? BANKS }),
    ...extra,
  };
}

function renderConnect(url: string) {
  return renderRoutes(
    [
      { path: "/connect", element: <ConnectPage /> },
      { path: "/accounts", element: <p>Accounts page</p> },
    ],
    { initialEntries: [url] },
  );
}

function urlParams(router: { state: { location: { search: string } } }) {
  return Object.fromEntries(new URLSearchParams(router.state.location.search));
}

const CONSENT_URL = "/connect?step=consent&country=IT&bank=Banca%20Esempio";

describe("ConnectPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.mocked(feedback).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preselects the settings country and moves to the bank step", async () => {
    stubApi(handlers());
    const { router } = renderConnect("/connect");
    const select = await screen.findByLabelText("Country");
    expect((select as HTMLSelectElement).value).toBe("IT");
    fireEvent.click(screen.getByRole("button", { name: "Choose a bank" }));
    await screen.findByRole("heading", { name: "Choose your bank" });
    expect(urlParams(router)).toEqual({ step: "bank", country: "IT" });
  });

  it("offers the countries reported by the bank status, sorted by name", async () => {
    stubApi(handlers());
    renderConnect("/connect");
    const select = await screen.findByLabelText("Country");
    const labels = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual(["Choose a country", "Finland", "Germany", "Italy"]);
  });

  it("falls back to the curated list when the status reports no countries", async () => {
    stubApi(handlers({}, { status: { ...STATUS_OK, countries: [] } }));
    renderConnect("/connect");
    const select = await screen.findByLabelText("Country");
    const labels = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toContain("Italy");
    expect(labels).toContain("Austria");
    expect(labels.length).toBeGreaterThan(20);
  });

  it("lists banks with a beta badge, searches without accents and picks a bank", async () => {
    stubApi(handlers());
    const { router } = renderConnect("/connect?step=bank&country=IT");
    await screen.findByRole("button", { name: /Banca Esempio/ });
    const northwind = screen.getByRole("button", { name: /Northwind Bank/ });
    expect(within(northwind).getByText("Beta")).toBeTruthy();
    expect(screen.getAllByTestId("bank-option")).toHaveLength(3);

    fireEvent.change(screen.getByLabelText("Search banks"), { target: { value: "peru" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Banca Esempio/ })).toBeNull());
    expect(screen.getByRole("button", { name: /Banca Perù/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search banks"), { target: { value: "zzzz" } });
    await screen.findByText("No bank matches “zzzz”");

    fireEvent.click(screen.getByRole("button", { name: "Show all banks" }));
    fireEvent.click(await screen.findByRole("button", { name: /Northwind Bank/ }));
    await screen.findByTestId("connect-start");
    expect(urlParams(router)).toEqual({
      step: "consent",
      country: "IT",
      bank: "Northwind Bank",
    });
  });

  it("defaults the duration to the bank maximum when the settings value is higher", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    stubApi(handlers({}, { settings: settingsResponse({ consentDays: 180 }) }));
    renderConnect("/connect?step=consent&country=IT&bank=Northwind%20Bank");
    const duration = await screen.findByLabelText("Access duration");
    expect((duration as HTMLSelectElement).value).toBe("90");
    expect(screen.getByTestId("consent-end").textContent).toContain("7 February 2027");
    expect(screen.getByText(/allows at most 90 days/)).toBeTruthy();
    expect(screen.getByText(/cannot make payments/)).toBeTruthy();
    fireEvent.change(duration, { target: { value: "30" } });
    expect(screen.getByTestId("consent-end").textContent).toContain("9 December 2026");
  });

  it("defaults the duration to the settings value when the bank allows more", async () => {
    stubApi(handlers({}, { settings: settingsResponse({ consentDays: 60 }) }));
    renderConnect(CONSENT_URL);
    const duration = await screen.findByLabelText("Access duration");
    expect((duration as HTMLSelectElement).value).toBe("60");
    expect(screen.queryByText(/allows at most/)).toBeNull();
  });

  it("starts the connection and redirects to the bank", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = stubApi(
      handlers({
        "POST /api/connections": () => ({
          status: 200,
          body: { redirectUrl: "https://auth.example.test/ais/start?sessionid=abc" },
        }),
      }),
    );
    renderConnect(CONSENT_URL);
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Banca Esempio" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://auth.example.test/ais/start?sessionid=abc"),
    );
    const call = fetchMock.mock.calls.find(([input]) => input === "/api/connections");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      aspspName: "Banca Esempio",
      aspspCountry: "IT",
      consentDays: 180,
    });
  });

  it("refuses a redirect address that is not http or https", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    stubApi(
      handlers({
        "POST /api/connections": () => ({
          status: 200,
          body: { redirectUrl: "javascript:alert(1)" },
        }),
      }),
    );
    renderConnect(CONSENT_URL);
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Banca Esempio" }));
    await waitFor(() =>
      expect(feedback).toHaveBeenCalledWith(
        "The connection could not be started",
        expect.any(String),
        "error",
      ),
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it.each([
    [
      503,
      { error: "Banking is not configured", code: "banking_not_configured" },
      "Bank connections are not set up",
      "warning",
    ],
    [
      404,
      { error: "Unknown bank", code: "unknown_bank" },
      "This bank is no longer available",
      "warning",
    ],
    [
      502,
      { error: "Bank error", code: "REDIRECT_URI_NOT_ALLOWED" },
      "The return address is not allowed",
      "error",
    ],
    [
      502,
      { error: "Bank error", code: "bank_error" },
      "The bank could not start the connection",
      "error",
    ],
  ])("reports a %i start error as a %s toast", async (status, body, title, tone) => {
    stubApi(handlers({ "POST /api/connections": () => ({ status, body }) }));
    renderConnect(CONSENT_URL);
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Banca Esempio" }));
    await waitFor(() => expect(feedback).toHaveBeenCalledWith(title, expect.any(String), tone));
  });

  it("returns to the bank list when the bank is no longer offered", async () => {
    stubApi(
      handlers({
        "POST /api/connections": () => ({
          status: 404,
          body: { error: "Unknown bank", code: "unknown_bank" },
        }),
      }),
    );
    const { router } = renderConnect(CONSENT_URL);
    fireEvent.click(await screen.findByRole("button", { name: "Continue to Banca Esempio" }));
    await screen.findByRole("heading", { name: "Choose your bank" });
    expect(urlParams(router).step).toBe("bank");
    expect(urlParams(router).bank).toBeUndefined();
  });

  it("explains that credentials are missing when banking is not configured", async () => {
    stubApi(
      handlers(
        {},
        {
          status: {
            ...STATUS_OK,
            configured: false,
            environment: null,
            active: null,
            redirectUrlAllowed: null,
            countries: [],
          },
        },
      ),
    );
    renderConnect("/connect");
    await screen.findByText("Bank connections are not set up yet");
    expect(screen.getByText(/docs\/enable-banking\.md/)).toBeTruthy();
    expect(screen.queryByLabelText("Country")).toBeNull();
  });

  it("shows the same explanation when the bank list answers 503", async () => {
    stubApi(
      handlers({
        "GET /api/banks/aspsps?country=IT": () => ({
          status: 503,
          body: { error: "Banking is not configured", code: "banking_not_configured" },
        }),
      }),
    );
    renderConnect("/connect?step=bank&country=IT");
    await screen.findByText("Bank connections are not set up yet");
  });

  it("warns when the application is inactive or the return address is not allowed", async () => {
    stubApi(handlers({}, { status: { ...STATUS_OK, active: false, redirectUrlAllowed: false } }));
    renderConnect("/connect");
    await screen.findByText("The Enable Banking application is not active");
    expect(screen.getByText("The return address is not allowed")).toBeTruthy();
    expect(screen.getByText("https://bursar.example.test/api/banks/callback")).toBeTruthy();
    expect(screen.getByLabelText("Country")).toBeTruthy();
  });

  it.each(["/connect?step=consent", "/connect?step=bogus&country=IT"])(
    "falls back to the country step for %s",
    async (url) => {
      stubApi(handlers());
      renderConnect(url);
      await screen.findByRole("heading", { name: "Where is your bank?" });
    },
  );

  it("marks the current step in the step indicator", async () => {
    stubApi(handlers());
    renderConnect("/connect?step=bank&country=IT");
    const nav = await screen.findByRole("navigation", { name: "Steps" });
    const current = nav.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Bank");
    expect(within(nav).getByRole("button", { name: "Country" })).toBeTruthy();
  });

  it("renders the Connect a bank button as a link to the wizard", () => {
    renderRoutes([{ path: "/", element: <ConnectBankButton /> }]);
    const link = screen.getByRole("link", { name: "Connect a bank" });
    expect(link.getAttribute("href")).toBe("/connect");
  });
});
