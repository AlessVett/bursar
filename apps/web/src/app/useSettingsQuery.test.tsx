import { SETTINGS_DEFAULTS, type SettingsResponse } from "@bursar/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { useLocaleSync, useSettingsQuery } from "./useSettingsQuery";

function settingsWith(locale: "it" | "en"): SettingsResponse {
  return {
    values: { ...SETTINGS_DEFAULTS, locale },
    system: {
      timezone: "Europe/Rome",
      publicUrl: "https://bursar.example.test",
      enableBankingConfigured: true,
      smtpConfigured: false,
      backupTarget: "local",
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.localStorage.clear();
});

describe("useSettingsQuery", () => {
  it("loads the settings from /api/settings", async () => {
    const fetchMock = stubFetch(settingsWith("it"));
    const { result } = renderHook(() => useSettingsQuery(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.system.timezone).toBe("Europe/Rome");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/settings");
  });

  it("turns a malformed response into a query error instead of a crash", async () => {
    stubFetch({ values: {} });
    const { result } = renderHook(() => useSettingsQuery(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useLocaleSync", () => {
  it("applies the server language once, after the settings arrive", async () => {
    const { rerender } = renderHook(
      ({ settings }: { settings: SettingsResponse | undefined }) => useLocaleSync(settings),
      { initialProps: { settings: undefined as SettingsResponse | undefined } },
    );
    expect(i18n.language).toBe("en");

    rerender({ settings: settingsWith("it") });
    await waitFor(() => expect(i18n.language).toBe("it"));

    await act(async () => {
      await i18n.changeLanguage("en");
    });
    rerender({ settings: settingsWith("it") });
    expect(i18n.language).toBe("en");
  });
});
