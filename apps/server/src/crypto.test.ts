import { describe, expect, it } from "vitest";
import { deriveKey, generateMasterKey, seal, unseal } from "./crypto";

const master = Buffer.alloc(32, 9);

describe("deriveKey", () => {
  it("is deterministic and separates purposes", () => {
    expect(deriveKey(master, "database")).toEqual(deriveKey(master, "database"));
    expect(deriveKey(master, "database")).not.toEqual(deriveKey(master, "totp"));
    expect(deriveKey(master, "documents")).toHaveLength(32);
  });

  it("rejects a master key of the wrong size", () => {
    expect(() => deriveKey(Buffer.alloc(16), "totp")).toThrow(/32 bytes/);
  });
});

describe("seal and unseal", () => {
  const key = deriveKey(master, "totp");

  it("round-trips data with a fresh nonce each time", () => {
    const first = seal(key, Buffer.from("secret"));
    const second = seal(key, Buffer.from("secret"));
    expect(first).not.toEqual(second);
    expect(unseal(key, first).toString()).toBe("secret");
  });

  it("detects tampering", () => {
    const sealed = seal(key, Buffer.from("secret"));
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff;
    expect(() => unseal(key, sealed)).toThrow();
  });

  it("refuses the wrong key", () => {
    const sealed = seal(key, Buffer.from("secret"));
    expect(() => unseal(deriveKey(master, "documents"), sealed)).toThrow();
  });

  it("refuses an unknown format version", () => {
    const sealed = seal(key, Buffer.from("secret"));
    sealed[0] = 2;
    expect(() => unseal(key, sealed)).toThrow(/version/);
  });
});

describe("generateMasterKey", () => {
  it("produces 32 random bytes as base64", () => {
    const value = generateMasterKey();
    expect(Buffer.from(value, "base64")).toHaveLength(32);
    expect(value).not.toBe(generateMasterKey());
  });
});
