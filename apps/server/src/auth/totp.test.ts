import { describe, expect, it } from "vitest";
import { createTotpSetup, generateTotpCode, TOTP_PERIOD_SECONDS, verifyTotp } from "./totp";

const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
const STEP = Math.floor(NOW / 1000 / TOTP_PERIOD_SECONDS);

describe("totp", () => {
  it("accepts the current code and returns its time step", () => {
    const { secret } = createTotpSetup("owner");
    expect(verifyTotp(secret, generateTotpCode(secret, NOW), 0, NOW)).toEqual({
      ok: true,
      step: STEP,
    });
  });

  it("accepts a code from the previous window", () => {
    const { secret } = createTotpSetup("owner");
    const previous = generateTotpCode(secret, NOW - TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotp(secret, previous, 0, NOW)).toEqual({ ok: true, step: STEP - 1 });
  });

  it("rejects a code whose step was already used", () => {
    const { secret } = createTotpSetup("owner");
    expect(verifyTotp(secret, generateTotpCode(secret, NOW), STEP, NOW)).toEqual({ ok: false });
  });

  it("rejects a wrong code", () => {
    const { secret } = createTotpSetup("owner");
    const code = generateTotpCode(secret, NOW);
    const wrong = code === "000000" ? "111111" : "000000";
    expect(verifyTotp(secret, wrong, 0, NOW)).toEqual({ ok: false });
  });

  it("builds an otpauth URI for authenticator apps", () => {
    const { uri, secret } = createTotpSetup("owner");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("issuer=Bursar");
  });
});
