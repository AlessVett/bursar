import { createPrivateKey, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";

export const EB_JWT_ISSUER = "enablebanking.com";
export const EB_JWT_AUDIENCE = "api.enablebanking.com";
export const EB_JWT_DEFAULT_TTL_SECONDS = 3600;
/** Enable Banking rejects tokens that live longer than 24 hours. */
export const EB_JWT_MAX_TTL_SECONDS = 86_400;
/** A cached token is replaced once it has this many seconds left or fewer. */
export const EB_JWT_RENEW_BEFORE_SECONDS = 300;

interface SignedToken {
  token: string;
  exp: number;
}

function loadRsaKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    // Never include the PEM or the parser's message: it can quote the input.
    throw new Error("The Enable Banking private key cannot be parsed");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("The Enable Banking private key must be an RSA key");
  }
  return key;
}

/**
 * Signs the application JWT that authenticates every Enable Banking request (eb-api-notes.md §1).
 * PKCS#1 ("BEGIN RSA PRIVATE KEY") and PKCS#8 ("BEGIN PRIVATE KEY") PEMs both load.
 */
export function createJwtSigner(options: {
  applicationId: string;
  privateKeyPem: string;
  now?: () => number;
  ttlSeconds?: number;
}): { token(): Promise<string> } {
  const ttl = options.ttlSeconds ?? EB_JWT_DEFAULT_TTL_SECONDS;
  if (
    !Number.isInteger(ttl) ||
    ttl <= EB_JWT_RENEW_BEFORE_SECONDS ||
    ttl > EB_JWT_MAX_TTL_SECONDS
  ) {
    throw new RangeError(
      `ttlSeconds must be an integer between ${EB_JWT_RENEW_BEFORE_SECONDS + 1} and ${EB_JWT_MAX_TTL_SECONDS}`,
    );
  }
  const now = options.now ?? Date.now;
  const key = loadRsaKey(options.privateKeyPem);
  let cached: SignedToken | null = null;
  let pending: Promise<SignedToken> | null = null;

  async function sign(iat: number): Promise<SignedToken> {
    const exp = iat + ttl;
    const token = await new SignJWT({})
      .setProtectedHeader({ typ: "JWT", alg: "RS256", kid: options.applicationId })
      .setIssuer(EB_JWT_ISSUER)
      .setAudience(EB_JWT_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key);
    return { token, exp };
  }

  return {
    async token() {
      const nowSeconds = Math.floor(now() / 1000);
      if (cached && cached.exp - nowSeconds > EB_JWT_RENEW_BEFORE_SECONDS) return cached.token;
      if (!pending) {
        pending = sign(nowSeconds)
          .then((signed) => {
            cached = signed;
            return signed;
          })
          .finally(() => {
            pending = null;
          });
      }
      return (await pending).token;
    },
  };
}
