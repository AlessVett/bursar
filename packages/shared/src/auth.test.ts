import { describe, expect, it } from "vitest";
import { loginRequestSchema, setupStartRequestSchema, totpCodeSchema } from "./auth";

describe("auth schemas", () => {
  it("accepts a six-digit TOTP code and rejects anything else", () => {
    expect(totpCodeSchema.safeParse("123456").success).toBe(true);
    expect(totpCodeSchema.safeParse("12345").success).toBe(false);
    expect(totpCodeSchema.safeParse("12345a").success).toBe(false);
  });

  it("requires a setup code and a password of at least 12 characters", () => {
    expect(setupStartRequestSchema.safeParse({ setupCode: "abc", password: "short" }).success).toBe(
      false,
    );
    expect(
      setupStartRequestSchema.safeParse({ setupCode: "", password: "a-long-enough-pass" }).success,
    ).toBe(false);
    expect(
      setupStartRequestSchema.safeParse({ setupCode: "abc", password: "a-long-enough-pass" })
        .success,
    ).toBe(true);
  });

  it("accepts any non-empty password at login", () => {
    expect(loginRequestSchema.safeParse({ password: "x", code: "000000" }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: "", code: "000000" }).success).toBe(false);
  });
});
