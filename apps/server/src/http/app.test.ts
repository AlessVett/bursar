import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OwnerStore } from "../auth/owner";
import { FailureLimiter } from "../auth/rate-limit";
import type { AuthDeps } from "../auth/routes";
import { SessionStore } from "../auth/sessions";
import { SetupCode } from "../auth/setup-code";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { API_BODY_LIMIT_BYTES, createApp } from "./app";

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
