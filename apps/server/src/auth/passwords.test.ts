import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "wrong password")).toBe(false);
  });

  it("returns false for a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});
