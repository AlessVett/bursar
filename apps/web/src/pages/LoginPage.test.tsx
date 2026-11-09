import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { LoginPage } from "./LoginPage";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LoginPage />
    </QueryClientProvider>,
  );
}

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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
    const fetchMock = stubFetch(401, { error: "Invalid credentials" });
    renderPage();
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
    stubFetch(429, { error: "Too many attempts" });
    renderPage();
    submit("whatever", "123456");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many attempts. Wait 15 minutes and try again.",
    );
  });
});
