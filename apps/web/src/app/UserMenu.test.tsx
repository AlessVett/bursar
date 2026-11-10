import type { SettingsResponse } from "@bursar/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { queryKeys } from "../lib/query-keys";
import { renderRoutes, stubApi } from "../test/router";
import { UserMenu } from "./UserMenu";

const SAVED = {
  values: { locale: "en" },
  system: { timezone: "Europe/Rome" },
} as unknown as SettingsResponse;

function renderMenu() {
  return renderRoutes([{ path: "/", element: <UserMenu /> }]);
}

beforeEach(async () => {
  await i18n.changeLanguage("it");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

describe("UserMenu language", () => {
  it("switches the language and saves it as the locale setting", async () => {
    const fetchMock = stubApi({ "PATCH /api/settings": () => ({ status: 200, body: SAVED }) });
    const { client } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Apri il menu utente" }));
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(`${init?.method} ${String(url)}`).toBe("PATCH /api/settings");
    expect(JSON.parse(String(init?.body))).toEqual({ locale: "en" });
    expect(i18n.language).toBe("en");
    await waitFor(() => expect(client.getQueryData(queryKeys.settings)).toEqual(SAVED));
  });

  it("does not call the API when the current language is chosen again", () => {
    const fetchMock = stubApi({});
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Apri il menu utente" }));
    fireEvent.click(screen.getByRole("button", { name: "Italiano" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
