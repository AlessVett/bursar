import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../http/app";
import { createTestApp } from "../test/app";
import { createTestDatabase } from "../test/db";
import { bankCallbackRoutes } from "./callback";
import { connectRoutes } from "./connect-routes";

const app = new Hono<AppEnv>().route("/api/banks/callback", bankCallbackRoutes());
const callback = (query: string) => app.request(`/api/banks/callback${query}`);
const target = (response: Response) =>
  new URL(response.headers.get("location") ?? "", "https://panel.invalid");

describe("GET /api/banks/callback", () => {
  it("redirects to the panel page with only the allowed parameters", async () => {
    const response = await callback(
      "?state=abcdefghijklmnop0123&code=0f1e2d3c&error=access_denied" +
        "&error_description=Cancelled%20by%20user&next=%2F%2Fevil.example.test&iss=x",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/connect/callback?state=abcdefghijklmnop0123&code=0f1e2d3c&error=access_denied" +
        "&error_description=Cancelled+by+user",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
  });

  it("truncates every forwarded value to 512 characters", async () => {
    const response = await callback(
      `?state=${"s".repeat(600)}&error_description=${"d".repeat(900)}`,
    );
    const params = target(response).searchParams;
    expect(params.get("state")).toBe("s".repeat(512));
    expect(params.get("error_description")).toBe("d".repeat(512));
  });

  it("re-encodes values so they cannot smuggle parameters or change the target", async () => {
    const response = await callback(
      `?state=${encodeURIComponent("abc&next=//evil.example.test")}&code=${encodeURIComponent("x#y")}`,
    );
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("/connect/callback?")).toBe(true);
    const url = target(response);
    expect(url.origin).toBe("https://panel.invalid");
    expect([...url.searchParams.keys()]).toEqual(["state", "code"]);
    expect(url.searchParams.get("state")).toBe("abc&next=//evil.example.test");
    expect(url.searchParams.get("code")).toBe("x#y");
  });

  it("redirects to the bare page when no parameter is present or all are empty", async () => {
    expect((await callback("")).headers.get("location")).toBe("/connect/callback");
    expect((await callback("?state=&code=")).headers.get("location")).toBe("/connect/callback");
  });

  it("forwards the first value of a repeated parameter", async () => {
    const response = await callback("?state=first-state-value-0001&state=second-state-value-02");
    expect(target(response).searchParams.getAll("state")).toEqual(["first-state-value-0001"]);
  });

  it("needs no session while the code exchange does", async () => {
    const database = createTestDatabase();
    try {
      const test = await createTestApp({
        database,
        publicRouters: [{ prefix: "/api/banks/callback", router: bankCallbackRoutes() }],
        routers: [{ prefix: "/api/connections", router: connectRoutes({ service: null }) }],
      });
      const redirect = await test.app.request(
        "/api/banks/callback?state=abcdefghijklmnop0123&code=0f1e2d3c",
      );
      expect(redirect.status).toBe(303);
      expect(redirect.headers.get("location")).toBe(
        "/connect/callback?state=abcdefghijklmnop0123&code=0f1e2d3c",
      );
      expect(redirect.headers.get("cache-control")).toBe("no-store");
      const exchange = await test.app.request("/api/connections/complete", {
        method: "POST",
        headers: { origin: test.origin, "content-type": "application/json" },
        body: JSON.stringify({ state: "abcdefghijklmnop0123", code: "0f1e2d3c" }),
      });
      expect(exchange.status).toBe(401);
    } finally {
      database.dispose();
    }
  });
});
