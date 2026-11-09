import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { accessGuard } from "./access";

const TEAM = "team.example.test";
const ISSUER = `https://${TEAM}`;
const AUDIENCE = "test-audience";

async function setupKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
  const sign = (claims: { audience?: string; issuer?: string; exp?: number | string } = {}) =>
    new SignJWT({ email: "owner@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(claims.issuer ?? ISSUER)
      .setAudience(claims.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "5m")
      .sign(privateKey);
  return { getKey: createLocalJWKSet({ keys: [jwk] }), sign };
}

function appWith(getKey: ReturnType<typeof createLocalJWKSet>) {
  const app = new Hono();
  app.use("*", accessGuard({ teamDomain: TEAM, audience: AUDIENCE, getKey }));
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/api/thing", (c) => c.text("thing"));
  return app;
}

const withToken = (token: string) => ({ headers: { "cf-access-jwt-assertion": token } });

describe("accessGuard", () => {
  it("rejects requests without a token", async () => {
    const { getKey } = await setupKeys();
    expect((await appWith(getKey).request("/api/thing")).status).toBe(403);
  });

  it("accepts a valid token", async () => {
    const { getKey, sign } = await setupKeys();
    const res = await appWith(getKey).request("/api/thing", withToken(await sign()));
    expect(res.status).toBe(200);
  });

  it("rejects a token for another audience or issuer", async () => {
    const { getKey, sign } = await setupKeys();
    const app = appWith(getKey);
    expect((await app.request("/api/thing", withToken(await sign({ audience: "x" })))).status).toBe(
      403,
    );
    expect(
      (await app.request("/api/thing", withToken(await sign({ issuer: "https://evil.test" }))))
        .status,
    ).toBe(403);
  });

  it("rejects an expired token", async () => {
    const { getKey, sign } = await setupKeys();
    const expired = await sign({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await appWith(getKey).request("/api/thing", withToken(expired))).status).toBe(403);
  });

  it("lets the health check through without a token", async () => {
    const { getKey } = await setupKeys();
    expect((await appWith(getKey).request("/healthz")).status).toBe(200);
  });
});
