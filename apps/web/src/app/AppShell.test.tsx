import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { useUi } from "../store/ui";
import { renderRoutes, stubApi, testQueryClient } from "../test/router";
import { AppShell } from "./AppShell";
import { RouteErrorBoundary } from "./ErrorBoundary";
import { appRoutes } from "./router";

const signedIn = { setupRequired: false, authenticated: true };

function Boom(): never {
  throw new Error("page crashed");
}

describe("AppShell", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useUi.setState({ privacy: false, sidebarCollapsed: false });
    stubApi({ "GET /api/auth/status": () => ({ status: 200, body: signedIn }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows only shipped routes in the navigation and the route title in the topbar", async () => {
    renderRoutes(appRoutes(), { client: testQueryClient(signedIn), initialEntries: ["/"] });
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent ?? "");
    expect(labels.some((label) => label.startsWith("Home"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Transactions"))).toBe(true);
    expect(labels.some((label) => label.startsWith("Documents"))).toBe(false);
    expect(within(nav).queryByText("Agents")).toBeNull();
    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    // The topbar is the first banner landmark; its title comes from the registry.
    expect(screen.getAllByRole("banner")[0]?.textContent).toContain("Home");
  });

  it("renders unshipped and unknown paths as Page not found inside the shell", async () => {
    renderRoutes(appRoutes(), {
      client: testQueryClient(signedIn),
      initialEntries: ["/documents"],
    });
    expect(await screen.findByText("This address does not match any page in Bursar.")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Home" }).getAttribute("href")).toBe("/");
  });

  it("closes the mobile drawer on a route change", async () => {
    const { router } = renderRoutes(appRoutes(), {
      client: testQueryClient(signedIn),
      initialEntries: ["/missing"],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open the menu" }));
    const drawer = screen.getByRole("dialog", { name: "Main navigation" });
    fireEvent.click(within(drawer).getByRole("link", { name: "Home" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Main navigation" })).toBeNull(),
    );
  });

  it("closes the mobile drawer on Escape", async () => {
    renderRoutes(appRoutes(), { client: testQueryClient(signedIn), initialEntries: ["/"] });
    fireEvent.click(await screen.findByRole("button", { name: "Open the menu" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Main navigation" })).toBeNull();
  });

  it("opens the palette with Ctrl+K and toggles privacy with Ctrl+Shift+H", async () => {
    renderRoutes(appRoutes(), { client: testQueryClient(signedIn), initialEntries: ["/"] });
    await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("combobox")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    fireEvent.keyDown(window, { key: "H", ctrlKey: true, shiftKey: true });
    expect(useUi.getState().privacy).toBe(true);
    expect(screen.getByRole("button", { name: "Show amounts" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("collapses the sidebar into a rail with tooltips", async () => {
    renderRoutes(appRoutes(), { client: testQueryClient(signedIn), initialEntries: ["/"] });
    fireEvent.click(await screen.findByRole("button", { name: "Collapse the sidebar" }));
    expect(useUi.getState().sidebarCollapsed).toBe(true);
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByRole("link", { name: "Home" }).getAttribute("title")).toBe("Home");
  });

  it("shows the error boundary inside the shell when a page crashes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderRoutes(
      [
        {
          element: <AppShell />,
          children: [
            { errorElement: <RouteErrorBoundary />, children: [{ path: "/", element: <Boom /> }] },
          ],
        },
      ],
      { client: testQueryClient(signedIn) },
    );
    expect(await screen.findByText("Something went wrong")).toBeTruthy();
    expect(document.querySelector("[data-error-boundary]")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
  });
});
