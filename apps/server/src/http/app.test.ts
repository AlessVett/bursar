import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

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
