import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { createJwtSigner, EB_JWT_AUDIENCE, EB_JWT_ISSUER } from "./jwt";

const APPLICATION_ID = "e1d1e636-f2a9-4410-9173-2f86f638e24b";
const START_MS = Date.UTC(2026, 10, 9, 8, 0, 0);

function rsaKeys(type: "pkcs1" | "pkcs8") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type, format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKey: createPublicKey(publicKey) };
}

const PKCS8 = rsaKeys("pkcs8");
const PKCS1 = rsaKeys("pkcs1");

describe("createJwtSigner", () => {
  it("signs an RS256 token with the Enable Banking header and claims", async () => {
    const signer = createJwtSigner({
      applicationId: APPLICATION_ID,
      privateKeyPem: PKCS8.privateKeyPem,
      now: () => START_MS,
    });
    const token = await signer.token();
    const { payload, protectedHeader } = await jwtVerify(token, PKCS8.publicKey, {
      algorithms: ["RS256"],
      issuer: "enablebanking.com",
      audience: "api.enablebanking.com",
      currentDate: new Date(START_MS),
    });
    expect(protectedHeader).toEqual({ typ: "JWT", alg: "RS256", kid: APPLICATION_ID });
    expect(payload.iss).toBe(EB_JWT_ISSUER);
    expect(payload.aud).toBe(EB_JWT_AUDIENCE);
    expect(payload.iat).toBe(START_MS / 1000);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(3600);
  });

  it("reuses the cached token until fewer than 300 seconds remain", async () => {
    let now = START_MS;
    const signer = createJwtSigner({
      applicationId: APPLICATION_ID,
      privateKeyPem: PKCS8.privateKeyPem,
      now: () => now,
    });
    const first = await signer.token();
    now = START_MS + 3_299_000; // 301 s left
    expect(await signer.token()).toBe(first);
    now = START_MS + 3_300_000; // 300 s left: renew
    const renewed = await signer.token();
    expect(renewed).not.toBe(first);
    const { payload } = await jwtVerify(renewed, PKCS8.publicKey, {
      issuer: EB_JWT_ISSUER,
      audience: EB_JWT_AUDIENCE,
      currentDate: new Date(now),
    });
    expect(payload.iat).toBe((START_MS + 3_300_000) / 1000);
  });

  it("accepts PKCS#1 and PKCS#8 private keys", async () => {
    for (const keys of [PKCS1, PKCS8]) {
      const signer = createJwtSigner({
        applicationId: APPLICATION_ID,
        privateKeyPem: keys.privateKeyPem,
        now: () => START_MS,
      });
      const token = await signer.token();
      expect(decodeProtectedHeader(token).kid).toBe(APPLICATION_ID);
      await expect(
        jwtVerify(token, keys.publicKey, { currentDate: new Date(START_MS) }),
      ).resolves.toBeDefined();
    }
    expect(PKCS1.privateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
    expect(PKCS8.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("refuses a TTL above 24 hours", () => {
    const { privateKeyPem } = PKCS8;
    const options = { applicationId: APPLICATION_ID, privateKeyPem };
    expect(() => createJwtSigner({ ...options, ttlSeconds: 86_401 })).toThrow(RangeError);
    expect(() => createJwtSigner({ ...options, ttlSeconds: 86_400 })).not.toThrow();
  });

  it("refuses a key that is not RSA", () => {
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    expect(() =>
      createJwtSigner({ applicationId: APPLICATION_ID, privateKeyPem: privateKey }),
    ).toThrow(/RSA/);
  });

  it("refuses an unreadable key without echoing it", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nnot-a-key-0123456789\n-----END PRIVATE KEY-----";
    let message = "";
    try {
      createJwtSigner({ applicationId: APPLICATION_ID, privateKeyPem: pem });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/cannot be parsed/);
    expect(message).not.toContain("not-a-key");
  });
});
