import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner } from "../db/schema";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { OwnerStore, TotpStepReusedError } from "./owner";

const KEY = Buffer.alloc(32, 1);
const RECORD = { passwordHash: "$argon2id$x", totpSecret: "JBSWY3DPEHPK3PXP", lastTotpStep: 5 };

describe("OwnerStore", () => {
  let t: TestDatabase;
  let store: OwnerStore;

  beforeEach(() => {
    t = createTestDatabase();
    store = new OwnerStore(t.db, KEY);
  });
  afterEach(() => t.dispose());

  it("creates the owner and reads it back with the TOTP secret decrypted", () => {
    expect(store.exists()).toBe(false);
    store.create(RECORD, new Date(0));
    expect(store.exists()).toBe(true);
    expect(store.get()).toEqual(RECORD);
  });

  it("stores the TOTP secret encrypted", () => {
    store.create(RECORD, new Date(0));
    const row = t.db.select().from(owner).get();
    expect(row?.totpSecretEnc.toString("utf8")).not.toContain(RECORD.totpSecret);
  });

  it("updates the last used TOTP step", () => {
    store.create(RECORD, new Date(0));
    store.setLastTotpStep(42);
    expect(store.get()?.lastTotpStep).toBe(42);
  });

  it("rejects replaying the same or an older TOTP step and keeps the stored one", () => {
    store.create(RECORD, new Date(0));
    store.setLastTotpStep(42);
    expect(() => store.setLastTotpStep(42)).toThrow(TotpStepReusedError);
    expect(() => store.setLastTotpStep(10)).toThrow("TOTP step already used");
    expect(store.get()?.lastTotpStep).toBe(42);
  });

  it("throws when advancing the step without an owner", () => {
    expect(() => store.setLastTotpStep(1)).toThrow();
  });

  it("refuses a second owner", () => {
    store.create(RECORD, new Date(0));
    expect(() => store.create(RECORD, new Date(0))).toThrow();
  });
});
