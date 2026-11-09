import { Secret, TOTP } from "otpauth";

export const TOTP_PERIOD_SECONDS = 30;

function buildTotp(secret: Secret, label = "owner"): TOTP {
  return new TOTP({
    issuer: "Bursar",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret,
  });
}

export function createTotpSetup(label: string): { secret: string; uri: string } {
  const secret = new Secret({ size: 20 });
  return { secret: secret.base32, uri: buildTotp(secret, label).toString() };
}

export function verifyTotp(
  secret: string,
  code: string,
  lastUsedStep: number,
  nowMs: number,
): { ok: true; step: number } | { ok: false } {
  const delta = buildTotp(Secret.fromBase32(secret)).validate({
    token: code,
    timestamp: nowMs,
    window: 1,
  });
  if (delta === null) return { ok: false };
  const step = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS) + delta;
  if (step <= lastUsedStep) return { ok: false };
  return { ok: true, step };
}

export function generateTotpCode(secret: string, nowMs: number): string {
  return buildTotp(Secret.fromBase32(secret)).generate({ timestamp: nowMs });
}
