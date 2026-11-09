import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { SESSION_IDLE_MS, SessionStore } from "./sessions";

const DAY = 24 * 60 * 60 * 1000;

describe("SessionStore", () => {
  let t: TestDatabase;
  let now: number;
  let store: SessionStore;

  beforeEach(() => {
    t = createTestDatabase();
    now = Date.UTC(2026, 10, 9);
    store = new SessionStore(t.db, () => now);
  });
  afterEach(() => t.dispose());

  it("validates a fresh token and rejects unknown ones", () => {
    const token = store.create("test-agent");
    expect(store.validate(token)).toBeTypeOf("number");
    expect(store.validate("unknown")).toBeNull();
  });

  it("slides the expiry while the session is used", () => {
    const token = store.create(null);
    now += 6 * DAY;
    expect(store.validate(token)).not.toBeNull();
    now += 6 * DAY;
    expect(store.validate(token)).not.toBeNull();
  });

  it("expires after the idle period", () => {
    const token = store.create(null);
    now += SESSION_IDLE_MS + 1;
    expect(store.validate(token)).toBeNull();
  });

  it("revokes a token", () => {
    const token = store.create(null);
    store.revoke(token);
    expect(store.validate(token)).toBeNull();
  });

  it("purges expired sessions", () => {
    store.create(null);
    now += SESSION_IDLE_MS + 1;
    expect(store.purgeExpired()).toBe(1);
  });
});
