import path from "node:path";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OwnerStore } from "../auth/owner";
import { FailureLimiter } from "../auth/rate-limit";
import type { AuthDeps } from "../auth/routes";
import { SessionStore } from "../auth/sessions";
import { SetupCode } from "../auth/setup-code";
import { createTestApp, type TestApp } from "../test/app";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { API_BODY_LIMIT_BYTES, type AppEnv, createApp } from "./app";

const ORIGIN = "https://bursar.example.test";
const config = { publicUrl: new URL(ORIGIN), cfAccess: null, webDistDir: null };
const logger = pino({ level: "silent" });

describe("createApp", () => {
  it("reports health", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 503 when the health check fails", async () => {
    const app = createApp({ config, logger, healthCheck: () => false });
    expect((await app.request("/healthz")).status).toBe(503);
  });

  it("sets a strict content security policy", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/healthz");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("rejects mutating API requests without the panel's origin", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const post = (headers: Record<string, string>) =>
      app.request("/api/nope", { method: "POST", headers });
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: ORIGIN })).status).toBe(404);
  });

  it.each([
    "https://bursar.example.test.evil.test",
    "https://bursar.example.test:8443",
    "http://bursar.example.test",
    "https://sub.bursar.example.test",
    `${ORIGIN}/`,
    "null",
  ])("requires an exact Origin match, rejecting %s", async (origin) => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/api/nope", { method: "POST", headers: { origin } });
    expect(res.status).toBe(403);
  });

  it.each(["PUT", "PATCH", "DELETE"])("checks the Origin on %s", async (method) => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const send = (headers: Record<string, string>) => app.request("/api/nope", { method, headers });
    expect((await send({ origin: "https://evil.test" })).status).toBe(403);
    expect((await send({})).status).toBe(403);
    expect((await send({ origin: ORIGIN })).status).toBe(404);
  });
});

describe("createApp with auth routes", () => {
  let t: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    t = createTestDatabase();
    const setupCode = new SetupCode(path.join(t.dir, "setup-code"));
    setupCode.issue();
    const auth: AuthDeps = {
      owners: new OwnerStore(t.db, Buffer.alloc(32, 1)),
      sessions: new SessionStore(t.db),
      setupCode,
      limiter: new FailureLimiter(),
      accountLimiter: new FailureLimiter(20),
      secureCookies: true,
      now: Date.now,
      getClientIp: () => "203.0.113.7",
    };
    app = createApp({ config, logger, healthCheck: () => true, auth });
  });
  afterEach(() => t.dispose());

  const routes = [
    "/api/auth/login",
    "/api/auth/setup/start",
    "/api/auth/setup/confirm",
    "/api/auth/logout",
  ];

  it.each(routes)("rejects %s from a foreign or missing Origin", async (route) => {
    const send = (headers: Record<string, string>) =>
      app.request(route, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
    expect((await send({ origin: "https://evil.test" })).status).toBe(403);
    expect((await send({ origin: "https://bursar.example.test.evil.test" })).status).toBe(403);
    expect((await send({})).status).toBe(403);
    expect((await send({ origin: ORIGIN })).status).not.toBe(403);
  });

  const oversized = JSON.stringify({ password: "x".repeat(API_BODY_LIMIT_BYTES), code: "000000" });

  it("refuses an oversized body announced by Content-Length before parsing it", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(oversized)),
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large" });
  });

  it("refuses an oversized streamed body", async () => {
    const encoded = new TextEncoder().encode(oversized);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 8192) {
          controller.enqueue(encoded.subarray(offset, offset + 8192));
        }
        controller.close();
      },
    });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("passes bodies within the limit on to the route", async () => {
    const send = (password: string) =>
      app.request("/api/auth/login", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ password, code: "000000" }),
      });
    // Just under the limit: the route's schema rejects the long password, not the body limit.
    expect((await send("x".repeat(API_BODY_LIMIT_BYTES - 100))).status).toBe(400);
    expect((await send("a valid password")).status).toBe(409);
  });
});

describe("createApp with Cloudflare Access", () => {
  const TEAM = "team.example.test";
  const AUDIENCE = "test-audience";
  const cfAccess = { teamDomain: TEAM, audience: AUDIENCE };

  async function setup() {
    const trusted = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(trusted.publicKey)), kid: "k", alg: "RS256" };
    const sign = (key: CryptoKey) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(`https://${TEAM}`)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key);
    const app = createApp({
      config: { ...config, cfAccess },
      logger,
      healthCheck: () => true,
      accessKeys: createLocalJWKSet({ keys: [jwk] }),
    });
    return { app, trusted, other, sign };
  }

  const bearer = (token: string) => ({ headers: { "cf-access-jwt-assertion": token } });

  it("rejects API requests without a token", async () => {
    const { app } = await setup();
    expect((await app.request("/api/nope")).status).toBe(403);
  });

  it("lets the health check through without a token", async () => {
    const { app } = await setup();
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("accepts a token signed by the trusted key", async () => {
    const { app, trusted, sign } = await setup();
    const res = await app.request("/api/nope", bearer(await sign(trusted.privateKey)));
    expect(res.status).toBe(404);
  });

  it("rejects a token signed by an unrelated key", async () => {
    const { app, other, sign } = await setup();
    const res = await app.request("/api/nope", bearer(await sign(other.privateKey)));
    expect(res.status).toBe(403);
  });

  it("rejects an unsigned token", async () => {
    const { app } = await setup();
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part({ alg: "none" })}.${part({ iss: `https://${TEAM}`, aud: AUDIENCE })}.`;
    expect((await app.request("/api/nope", bearer(unsigned))).status).toBe(403);
  });
});

describe("createApp routers and Cache-Control", () => {
  let t: TestDatabase;
  let ta: TestApp;

  const sample = new Hono<AppEnv>();
  sample.get("/ping", (c) => c.json({ pong: true }));
  sample.post("/echo", async (c) => c.json({ received: await c.req.json() }));
  sample.get("/cached", (c) => {
    c.header("Cache-Control", "max-age=5");
    return c.json({ cached: true });
  });
  const open = new Hono<AppEnv>();
  open.get("/hello", (c) => c.json({ hello: "world" }));

  beforeEach(async () => {
    t = createTestDatabase();
    ta = await createTestApp({
      database: t,
      routers: [{ prefix: "/api/sample", router: sample }],
      publicRouters: [{ prefix: "/api/open", router: open }],
    });
  });
  afterEach(() => t.dispose());

  it("mounts routers behind the session and public routers without it", async () => {
    expect((await ta.app.request("/api/sample/ping")).status).toBe(401);
    expect((await ta.app.request("/api/open/hello")).status).toBe(200);
    expect(await ta.json("/api/sample/ping")).toMatchObject({ status: 200, body: { pong: true } });
  });

  it("keeps the auth routes working next to public routers", async () => {
    const status = await ta.app.request("/api/auth/status");
    expect(await status.json()).toEqual({ setupRequired: false, authenticated: false });
  });

  it("still answers unknown paths under a mounted prefix with the JSON 404", async () => {
    expect(await ta.json("/api/sample/missing")).toMatchObject({
      status: 404,
      body: { error: "Not found" },
    });
  });

  it("checks the Origin for mounted routers", async () => {
    const res = await ta.app.request("/api/sample/echo", {
      method: "POST",
      headers: { cookie: ta.cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("sets Cache-Control: no-store on every kind of /api response", async () => {
    const bigBody = JSON.stringify({ filler: "x".repeat(API_BODY_LIMIT_BYTES) });
    const responses: [string, Response][] = [
      ["me", await ta.app.request("/api/me", { headers: { cookie: ta.cookie } })],
      ["unauthenticated", await ta.app.request("/api/me")],
      ["auth status", await ta.app.request("/api/auth/status")],
      ["public router", await ta.app.request("/api/open/hello")],
      ["router", await ta.app.request("/api/sample/ping", { headers: { cookie: ta.cookie } })],
      ["404", await ta.app.request("/api/nope", { headers: { cookie: ta.cookie } })],
      [
        "foreign origin",
        await ta.app.request("/api/sample/echo", {
          method: "POST",
          headers: { origin: "https://evil.test", cookie: ta.cookie },
        }),
      ],
      [
        "oversized body",
        await ta.app.request("/api/sample/echo", {
          method: "POST",
          headers: {
            origin: ta.origin,
            cookie: ta.cookie,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(bigBody)),
          },
          body: bigBody,
        }),
      ],
    ];
    expect(responses.map(([, res]) => res.status)).toEqual([
      200, 401, 200, 200, 200, 404, 403, 413,
    ]);
    for (const [name, res] of responses) {
      expect(res.headers.get("cache-control"), name).toBe("no-store");
    }
  });

  it("sets no-store on the login response that carries the session cookie", async () => {
    const res = await ta.app.request("/api/auth/login", {
      method: "POST",
      headers: { origin: ta.origin, "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong password", code: "000000" }),
    });
    expect(res.status).not.toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps a Cache-Control header that a route sets itself", async () => {
    const res = await ta.app.request("/api/sample/cached", { headers: { cookie: ta.cookie } });
    expect(res.headers.get("cache-control")).toBe("max-age=5");
  });

  it("leaves non-API responses alone", async () => {
    const res = await ta.app.request("/healthz");
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("createTestApp", () => {
  let t: TestDatabase;
  beforeEach(() => {
    t = createTestDatabase();
  });
  afterEach(() => t.dispose());

  it("returns a working owner session and a JSON helper", async () => {
    const ta = await createTestApp({ database: t });
    expect(ta.cookie).toMatch(/^bursar_session=[\w-]+$/);
    expect(ta.origin).toBe("https://bursar.example.test");
    expect(await ta.json("/api/me")).toMatchObject({ status: 200, body: { authenticated: true } });
    expect(ta.sessions.peek(ta.cookie.slice("bursar_session=".length))).not.toBeNull();
  });

  it("adds origin, content-type and the cookie to mutating calls and parses empty bodies", async () => {
    const echo = new Hono<AppEnv>();
    echo.post("/", async (c) => c.json({ received: await c.req.json() }, 201));
    echo.delete("/", (c) => c.body(null, 204));
    const ta = await createTestApp({
      database: t,
      routers: [{ prefix: "/api/echo", router: echo }],
    });
    const created = await ta.json("/api/echo", { method: "POST", body: { a: 1 } });
    expect(created).toMatchObject({ status: 201, body: { received: { a: 1 } } });
    expect(created.headers.get("content-type")).toContain("application/json");
    expect(await ta.json("/api/echo", { method: "DELETE" })).toMatchObject({
      status: 204,
      body: null,
    });
  });

  it("honours an injected clock", async () => {
    let now = Date.UTC(2026, 10, 9, 9, 0, 0);
    const ta = await createTestApp({ database: t, now: () => now });
    now += 8 * 24 * 60 * 60_000;
    expect((await ta.json("/api/me")).status).toBe(401);
  });
});
