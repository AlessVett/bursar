import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "../api";
import { createQueryClient, isAccessDenied, isSessionExpired } from "./query-client";

function respond(status: number, body: string, contentType = "application/json") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers: { "content-type": contentType } })),
  );
}

function handlers() {
  return { onUnauthorized: vi.fn(), onAccessDenied: vi.fn() };
}

describe("error classification", () => {
  it("treats a 401 outside /api/auth as an expired session", () => {
    expect(isSessionExpired(new ApiError(401, "Not authenticated", { path: "/api/me" }))).toBe(
      true,
    );
    expect(isSessionExpired(new ApiError(401, "Invalid", { path: "/api/auth/login" }))).toBe(false);
    expect(isSessionExpired(new Error("401"))).toBe(false);
  });

  it("recognises Access 403s but not Bursar's own JSON 403s", () => {
    const json = { isJson: true, path: "/api/me" };
    expect(isAccessDenied(new ApiError(403, "Missing Cloudflare Access token", json))).toBe(true);
    expect(isAccessDenied(new ApiError(403, "Invalid Cloudflare Access token", json))).toBe(true);
    expect(isAccessDenied(new ApiError(403, "Forbidden", { isJson: false, path: "/api/me" }))).toBe(
      true,
    );
    expect(isAccessDenied(new ApiError(403, "Cross-origin request rejected", json))).toBe(false);
  });
});

describe("createQueryClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls onUnauthorized when a query gets a 401", async () => {
    respond(401, JSON.stringify({ error: "Not authenticated" }));
    const h = handlers();
    const client = createQueryClient(h);
    await client
      .fetchQuery({ queryKey: ["me"], queryFn: () => request("GET", "/api/me") })
      .catch(() => undefined);
    expect(h.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(h.onAccessDenied).not.toHaveBeenCalled();
  });

  it("ignores a 401 from the login route", async () => {
    respond(401, JSON.stringify({ error: "Invalid credentials" }));
    const h = handlers();
    const client = createQueryClient(h);
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => request("POST", "/api/auth/login", {}) })
      .execute(undefined)
      .catch(() => undefined);
    expect(h.onUnauthorized).not.toHaveBeenCalled();
  });

  it("calls onAccessDenied for the HTML 403 page of Cloudflare Access on a mutation", async () => {
    respond(403, "<html>Forbidden</html>", "text/html");
    const h = handlers();
    const client = createQueryClient(h);
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => request("PATCH", "/api/settings", { a: 1 }) })
      .execute(undefined)
      .catch(() => undefined);
    expect(h.onAccessDenied).toHaveBeenCalledTimes(1);
  });

  it("does not retry and does not refetch on focus", () => {
    const options = createQueryClient(handlers()).getDefaultOptions();
    expect(options.queries?.retry).toBe(false);
    expect(options.queries?.refetchOnWindowFocus).toBe(false);
  });
});

describe("request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads code and retryAt from a JSON error", async () => {
    respond(
      429,
      JSON.stringify({ error: "Rate limited", code: "rate_limited", retryAt: 1_800_000 }),
    );
    const error = await request("POST", "/api/accounts/1/sync").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      message: "Rate limited",
      code: "rate_limited",
      retryAt: 1_800_000,
      path: "/api/accounts/1/sync",
      isJson: true,
    });
  });

  it("keeps code null for a non-JSON error and uses the status text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html></html>", { status: 502, statusText: "Bad Gateway" })),
    );
    const error = await request("GET", "/api/summary").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 502, message: "Bad Gateway", code: null, isJson: false });
  });

  it("sends PATCH and DELETE with a JSON body and returns undefined for 204", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      request("PATCH", "/api/accounts/1", { nickname: "Main" }),
    ).resolves.toBeUndefined();
    await expect(request("DELETE", "/api/connections/1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/accounts/1", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "Main" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/connections/1", {
      method: "DELETE",
      credentials: "same-origin",
      headers: undefined,
      body: undefined,
    });
  });

  it("rejects a successful response that is not JSON", async () => {
    respond(200, "<!doctype html>", "text/html");
    await expect(request("GET", "/api/summary")).rejects.toMatchObject({
      message: "Invalid JSON response",
    });
  });
});
