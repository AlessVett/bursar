import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "../app/RequireAuth";
import i18n from "../i18n";
import { renderRoutes, stubApi } from "../test/router";
import { LoginPage } from "./LoginPage";

const routes = [
  {
    element: <RequireAuth area="auth" />,
    children: [{ path: "/login", element: <LoginPage /> }],
  },
  { path: "*", element: <p>landed</p> },
];

function submit(password: string, code: string) {
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("LoginPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the credentials and shows an error on 401", async () => {
    const fetchMock = stubApi({
      "GET /api/auth/status": () => ({
        status: 200,
        body: { setupRequired: false, authenticated: false },
      }),
      "POST /api/auth/login": () => ({ status: 401, body: { error: "Invalid credentials" } }),
    });
    renderRoutes(routes, { initialEntries: ["/login"] });
    await screen.findByLabelText("Password");
    submit("correct horse battery", "123456");
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong password or code.");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ password: "correct horse battery", code: "123456" }),
      }),
    );
  });

  it("shows the lockout message on 429", async () => {
    stubApi({
      "GET /api/auth/status": () => ({
        status: 200,
        body: { setupRequired: false, authenticated: false },
      }),
      "POST /api/auth/login": () => ({ status: 429, body: { error: "Too many attempts" } }),
    });
    renderRoutes(routes, { initialEntries: ["/login"] });
    await screen.findByLabelText("Password");
    submit("whatever", "123456");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many attempts. Wait 15 minutes and try again.",
    );
  });

  it("shows the session-expired notice and returns to next after signing in", async () => {
    let signedIn = false;
    stubApi({
      "GET /api/auth/status": () => ({
        status: 200,
        body: { setupRequired: false, authenticated: signedIn },
      }),
      "POST /api/auth/login": () => {
        signedIn = true;
        return { status: 200, body: { ok: true } };
      },
    });
    const { router } = renderRoutes(routes, {
      initialEntries: ["/login?expired=1&next=%2Fsettings%3Ftab%3Dbackups"],
    });
    expect((await screen.findByRole("status")).textContent).toBe(
      "Your session expired, sign in again.",
    );
    submit("correct horse battery", "123456");
    await waitFor(() =>
      expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(
        "/settings?tab=backups",
      ),
    );
    expect(await screen.findByText("landed")).toBeTruthy();
  });
});
