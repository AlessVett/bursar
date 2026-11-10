import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../http/app";
import { createTestApp } from "../test/app";
import { createTestDatabase } from "../test/db";
import { AspspCache } from "./aspsp-cache";
import type { EnableBankingApi } from "./client";
import { EnableBankingError } from "./errors";
import applicationFixture from "./fixtures/application.json";
import aspspsFixture from "./fixtures/aspsps.json";
import { clearLogoCache } from "./logo";
import { bankRoutes } from "./routes";
import { ebApplicationSchema, ebAspspListSchema } from "./schemas";

const PUBLIC_URL = new URL("https://bursar.example.test");
const APPLICATION = ebApplicationSchema.parse(applicationFixture);
const ASPSPS = ebAspspListSchema.parse(aspspsFixture).aspsps;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NORTHWIND_LOGO = "https://logos.example.test/brands/IT/northwind-bank.png";

const notStubbed = () => Promise.reject(new Error("not stubbed"));

function stubApi(overrides: Partial<EnableBankingApi>): EnableBankingApi {
  return {
    getApplication: notStubbed,
    listAspsps: notStubbed,
    startAuthorization: notStubbed,
    createSession: notStubbed,
    getSession: notStubbed,
    deleteSession: notStubbed,
    getBalances: notStubbed,
    getTransactions: notStubbed,
    ...overrides,
  };
}

function bare(deps: Parameters<typeof bankRoutes>[0]) {
  return new Hono<AppEnv>().route("/api/banks", bankRoutes(deps));
}

function configured(extra: { logoFetch?: typeof fetch; now?: () => number } = {}) {
  const listAspsps = vi.fn(async () => ASPSPS);
  const getApplication = vi.fn(async () => APPLICATION);
  const api = stubApi({ listAspsps, getApplication });
  const app = bare({
    api,
    aspsps: new AspspCache(api),
    publicUrl: PUBLIC_URL,
    fetchLogo: extra.logoFetch,
    now: extra.now,
  });
  return { app, listAspsps, getApplication };
}

function imageFetch(reply: () => Response) {
  return vi.fn<typeof fetch>(async () => reply());
}

const png = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });

beforeEach(() => clearLogoCache());

describe("bankRoutes", () => {
  it("reports an unconfigured integration", async () => {
    const res = await bare({ api: null, aspsps: null, publicUrl: PUBLIC_URL }).request(
      "/api/banks/status",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      environment: null,
      active: null,
      redirectUrlAllowed: null,
      countries: [],
      error: null,
    });
  });

  it("reports the application and whether the callback URL is registered", async () => {
    const res = await configured().app.request("/api/banks/status");
    expect(await res.json()).toEqual({
      configured: true,
      environment: "SANDBOX",
      active: true,
      redirectUrlAllowed: true,
      countries: ["FI", "IT"],
      error: null,
    });

    const api = stubApi({ getApplication: async () => APPLICATION });
    const other = bare({ api, aspsps: null, publicUrl: new URL("https://other.example.test") });
    expect(await (await other.request("/api/banks/status")).json()).toMatchObject({
      redirectUrlAllowed: false,
    });
  });

  it("caches the application for ten minutes", async () => {
    let now = 1_000_000;
    const { app, getApplication } = configured({ now: () => now });
    await app.request("/api/banks/status");
    now += 9 * 60_000;
    await app.request("/api/banks/status");
    expect(getApplication).toHaveBeenCalledTimes(1);
    now += 60_000;
    await app.request("/api/banks/status");
    expect(getApplication).toHaveBeenCalledTimes(2);
  });

  it("reports an Enable Banking error code on the status without failing", async () => {
    const api = stubApi({
      getApplication: async () => {
        throw new EnableBankingError(401, "UNAUTHORIZED_ACCESS", "Unauthorized");
      },
    });
    const res = await bare({ api, aspsps: null, publicUrl: PUBLIC_URL }).request(
      "/api/banks/status",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      environment: null,
      active: null,
      redirectUrlAllowed: null,
      countries: [],
      error: "UNAUTHORIZED_ACCESS",
    });
  });

  it("lists banks sorted with a natural collator and caches them", async () => {
    const { app, listAspsps } = configured();
    const res = await app.request("/api/banks/aspsps?country=IT");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aspsps: { name: string }[] };
    expect(body.aspsps.map((aspsp) => aspsp.name)).toEqual([
      "Banca Esempio",
      "Cassa Demo 2",
      "Cassa Demo 10",
      "Northwind Bank",
    ]);
    expect(body.aspsps).toContainEqual({
      name: "Northwind Bank",
      country: "IT",
      maximumConsentDays: 180,
      beta: false,
      hasLogo: true,
    });
    expect(body.aspsps).toContainEqual({
      name: "Banca Esempio",
      country: "IT",
      maximumConsentDays: 90,
      beta: true,
      hasLogo: true,
    });
    expect(body.aspsps).toContainEqual(
      expect.objectContaining({ name: "Cassa Demo 2", hasLogo: false }),
    );
    await app.request("/api/banks/aspsps?country=IT");
    expect(listAspsps).toHaveBeenCalledTimes(1);
  });

  it("validates the country", async () => {
    const { app } = configured();
    for (const query of ["?country=it", "?country=ITA", ""]) {
      const res = await app.request(`/api/banks/aspsps${query}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request", code: "invalid_request" });
    }
  });

  it("answers 503 when banking is not configured", async () => {
    const res = await bare({ api: null, aspsps: null, publicUrl: PUBLIC_URL }).request(
      "/api/banks/aspsps?country=IT",
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "banking_not_configured" });
  });

  it("answers 502 when the bank list is unavailable", async () => {
    const api = stubApi({
      listAspsps: async () => {
        throw new EnableBankingError(500, "ASPSP_ERROR", "Bank unavailable");
      },
    });
    const res = await bare({ api, aspsps: new AspspCache(api), publicUrl: PUBLIC_URL }).request(
      "/api/banks/aspsps?country=IT",
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "The bank list is unavailable",
      code: "bank_list_unavailable",
    });
  });

  it("proxies a bank logo from the ASPSP data with safe headers", async () => {
    const logoFetch = imageFetch(png);
    const { app } = configured({ logoFetch });
    const res = await app.request("/api/banks/logo?country=IT&name=Northwind%20Bank");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(String(logoFetch.mock.calls[0]?.[0])).toBe(NORTHWIND_LOGO);

    await app.request("/api/banks/logo?country=IT&name=Northwind%20Bank");
    expect(logoFetch).toHaveBeenCalledTimes(1);
  });

  it("never fetches a client-supplied URL", async () => {
    const logoFetch = imageFetch(png);
    const { app } = configured({ logoFetch });
    const smuggled = await app.request(
      "/api/banks/logo?country=IT&name=Northwind%20Bank&url=https%3A%2F%2Fevil.example.test%2Fx.png",
    );
    expect(smuggled.status).toBe(200);
    const asName = await app.request(
      "/api/banks/logo?country=IT&name=https%3A%2F%2Fevil.example.test%2Fx.png",
    );
    expect(asName.status).toBe(404);
    expect(logoFetch.mock.calls.map((call) => String(call[0]))).toEqual([NORTHWIND_LOGO]);
  });

  it("answers 404 for unknown banks, insecure logos and unfetchable images", async () => {
    const logoFetch = imageFetch(() => new Response("oops", { status: 500 }));
    const { app } = configured({ logoFetch });
    expect((await app.request("/api/banks/logo?country=IT&name=Unknown%20Bank")).status).toBe(404);
    expect((await app.request("/api/banks/logo?country=IT&name=Cassa%20Demo%202")).status).toBe(
      404,
    );
    expect(logoFetch).not.toHaveBeenCalled();
    expect((await app.request("/api/banks/logo?country=IT&name=Banca%20Esempio")).status).toBe(404);
    expect(logoFetch).toHaveBeenCalledTimes(1);
    expect((await app.request("/api/banks/logo?country=IT")).status).toBe(400);
    const unconfigured = bare({ api: null, aspsps: null, publicUrl: PUBLIC_URL });
    expect(
      (await unconfigured.request("/api/banks/logo?country=IT&name=Banca%20Esempio")).status,
    ).toBe(404);
  });

  it("rejects an oversize logo", async () => {
    const logoFetch = imageFetch(
      () =>
        new Response(new Uint8Array(300 * 1024), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const { app } = configured({ logoFetch });
    expect((await app.request("/api/banks/logo?country=IT&name=Cassa%20Demo%2010")).status).toBe(
      404,
    );
  });

  it("rejects a logo that is not an image", async () => {
    const logoFetch = imageFetch(
      () =>
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const { app } = configured({ logoFetch });
    expect((await app.request("/api/banks/logo?country=IT&name=Northwind%20Bank")).status).toBe(
      404,
    );
  });

  it("follows https redirects only", async () => {
    const redirectTo = (location: string) =>
      new Response(null, { status: 302, headers: { location } });
    const secure = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectTo("https://cdn.example.test/northwind.png"))
      .mockResolvedValueOnce(png());
    const first = configured({ logoFetch: secure });
    expect(
      (await first.app.request("/api/banks/logo?country=IT&name=Northwind%20Bank")).status,
    ).toBe(200);
    expect(String(secure.mock.calls[1]?.[0])).toBe("https://cdn.example.test/northwind.png");

    clearLogoCache();
    const insecure = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirectTo("http://cdn.example.test/northwind.png"));
    const second = configured({ logoFetch: insecure });
    expect(
      (await second.app.request("/api/banks/logo?country=IT&name=Northwind%20Bank")).status,
    ).toBe(404);
    expect(insecure).toHaveBeenCalledTimes(1);
  });

  it("requires a session when mounted in the app", async () => {
    const database = createTestDatabase();
    try {
      const api = stubApi({ getApplication: async () => APPLICATION });
      const t = await createTestApp({
        database,
        routers: [
          {
            prefix: "/api/banks",
            router: bankRoutes({ api, aspsps: new AspspCache(api), publicUrl: PUBLIC_URL }),
          },
        ],
      });
      expect((await t.app.request("/api/banks/status")).status).toBe(401);
      const authed = await t.json("/api/banks/status");
      expect(authed.status).toBe(200);
      expect(authed.body).toMatchObject({ configured: true, environment: "SANDBOX" });
    } finally {
      database.dispose();
    }
  });
});
