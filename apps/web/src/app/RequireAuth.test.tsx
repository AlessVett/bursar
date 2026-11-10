import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { queryKeys } from "../lib/query-keys";
import { renderRoutes, stubApi, testQueryClient } from "../test/router";
import { expireSession, loginPath, RequireAuth, safeNext } from "./RequireAuth";
import { LiveEvents } from "./useLiveEvents";

const routes = [
  {
    element: <RequireAuth area="auth" />,
    children: [
      { path: "/login", element: <p>login page</p> },
      { path: "/setup", element: <p>setup page</p> },
    ],
  },
  {
    element: <RequireAuth area="app" />,
    children: [{ path: "*", element: <p>app page</p> }],
  },
];

describe("safeNext and loginPath", () => {
  it("accepts in-app paths only", () => {
    expect(safeNext("/transactions?tab=in")).toBe("/transactions?tab=in");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("https://example.invalid/")).toBe("/");
    expect(safeNext("//example.invalid/")).toBe("/");
    expect(safeNext("/\\example.invalid")).toBe("/");
    expect(safeNext("/login?next=/x")).toBe("/");
    expect(safeNext("/\t/evil.example")).toBe("/");
    expect(safeNext("/\n/evil.example")).toBe("/");
    expect(safeNext("/\r/evil.example")).toBe("/");
    expect(safeNext("/a\\b")).toBe("/");
  });

  it("builds the login path with next and the expiry flag", () => {
    expect(loginPath("/")).toBe("/login");
    expect(loginPath("/settings?tab=backups")).toBe("/login?next=%2Fsettings%3Ftab%3Dbackups");
    expect(loginPath("/", { expired: true })).toBe("/login?expired=1");
  });
});

describe("RequireAuth", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a signed-out owner to the login page with next", async () => {
    const { router } = renderRoutes(routes, {
      client: testQueryClient({ setupRequired: false, authenticated: false }),
      initialEntries: ["/transactions?tab=in"],
    });
    expect(await screen.findByText("login page")).toBeTruthy();
    expect(router.state.location.search).toBe("?next=%2Ftransactions%3Ftab%3Din");
  });

  it("sends everyone to setup while setup is required", async () => {
    const { router } = renderRoutes(routes, {
      client: testQueryClient({ setupRequired: true, authenticated: false }),
      initialEntries: ["/login"],
    });
    expect(await screen.findByText("setup page")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/setup");
  });

  it("keeps setup closed once the owner exists", async () => {
    const { router } = renderRoutes(routes, {
      client: testQueryClient({ setupRequired: false, authenticated: false }),
      initialEntries: ["/setup"],
    });
    expect(await screen.findByText("login page")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("sends a signed-in owner from the login page to a safe next", async () => {
    const { router } = renderRoutes(routes, {
      client: testQueryClient({ setupRequired: false, authenticated: true }),
      initialEntries: ["/login?next=%2F%2Fexample.invalid"],
    });
    expect(await screen.findByText("app page")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
  });

  it("offers a retry when the server is unreachable", async () => {
    stubApi({ "GET /api/auth/status": () => ({ status: 503, body: { error: "Unavailable" } }) });
    renderRoutes(routes, { initialEntries: ["/"] });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The server is not reachable. Try again in a moment.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("keeps the signed-in page and the live stream when a status refetch fails", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      closed = false;
      onerror: ((event: Event) => void) | null = null;
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener(): void {}
      close(): void {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    let reachable = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (!reachable) throw new TypeError("Failed to fetch");
      expect(String(input)).toBe("/api/auth/status");
      return new Response(JSON.stringify({ setupRequired: false, authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const live = [
      {
        element: <RequireAuth area="app" />,
        children: [
          {
            path: "*",
            element: (
              <>
                <LiveEvents />
                <p>app page</p>
              </>
            ),
          },
        ],
      },
    ];
    const client = testQueryClient({ setupRequired: false, authenticated: true });
    renderRoutes(live, { client, initialEntries: ["/transactions"] });
    expect(await screen.findByText("app page")).toBeTruthy();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // A server restart: the stream drops and the status refetch cannot reach the server.
    reachable = false;
    act(() => FakeEventSource.instances[0]?.onerror?.(new Event("error")));
    await waitFor(() => expect(client.getQueryState(queryKeys.authStatus)?.status).toBe("error"));
    expect(screen.getByText("app page")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    // The stream keeps trying (1 s after the first failure) and the page stays mounted.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2), { timeout: 3_000 });
    expect(FakeEventSource.instances[1]?.closed).toBe(false);
    reachable = true;
    expect(screen.getByText("app page")).toBeTruthy();
  });

  it("expireSession marks the session as gone and opens the login page with the notice", async () => {
    const client = testQueryClient({ setupRequired: false, authenticated: true });
    const { router } = renderRoutes(routes, { client, initialEntries: ["/settings?tab=x"] });
    expect(await screen.findByText("app page")).toBeTruthy();
    expireSession(router, client);
    await waitFor(() =>
      expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(
        "/login?expired=1&next=%2Fsettings%3Ftab%3Dx",
      ),
    );
    expect(await screen.findByText("login page")).toBeTruthy();
    expect(client.getQueryData(queryKeys.authStatus)).toEqual({
      setupRequired: false,
      authenticated: false,
    });
  });
});
