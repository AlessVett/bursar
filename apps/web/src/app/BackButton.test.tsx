import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { renderRoutes } from "../test/router";
import { BackButton } from "./BackButton";

const routes = [
  { path: "/accounts/:accountId", element: <BackButton routeId="account" /> },
  { path: "*", element: <p>elsewhere</p> },
];

describe("BackButton", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    window.history.replaceState(null, "");
  });

  it("goes to the breadcrumb parent when the page was opened directly", async () => {
    window.history.replaceState({ idx: 0 }, "");
    const { router } = renderRoutes(routes, { initialEntries: ["/accounts/12"] });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/accounts"));
  });

  it("goes back one step when there is in-app history", async () => {
    window.history.replaceState({ idx: 1 }, "");
    const { router } = renderRoutes(routes, {
      initialEntries: ["/transactions", "/accounts/12"],
      initialIndex: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/transactions"));
  });
});
