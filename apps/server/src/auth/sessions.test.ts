import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authSessions } from "../db/schema";
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

  it("stores only the SHA-256 hash of the token", () => {
    const token = store.create("test-agent");
    const rows = t.db.select().from(authSessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(token);
    expect(rows[0]?.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("peek validates a token without touching last_seen_at or the expiry", () => {
    const token = store.create(null);
    const [before] = t.db.select().from(authSessions).all();
    now += 10 * 60_000;
    expect(store.peek(token)).toBe(before?.id);
    const [after] = t.db.select().from(authSessions).all();
    expect(after?.lastSeenAt.getTime()).toBe(before?.lastSeenAt.getTime());
    expect(after?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());
    // validate, by contrast, slides both.
    expect(store.validate(token)).toBe(before?.id);
    const [slid] = t.db.select().from(authSessions).all();
    expect(slid?.lastSeenAt.getTime()).toBe(now);
    expect(slid?.expiresAt.getTime()).toBe(now + SESSION_IDLE_MS);
  });

  it("peek rejects unknown, revoked and expired tokens", () => {
    const token = store.create(null);
    expect(store.peek("unknown")).toBeNull();
    now += SESSION_IDLE_MS + 1;
    expect(store.peek(token)).toBeNull();
    const revoked = store.create(null);
    store.revoke(revoked);
    expect(store.peek(revoked)).toBeNull();
  });

  it("peek does not keep an idle session alive", () => {
    const token = store.create(null);
    now += SESSION_IDLE_MS - 1_000;
    expect(store.peek(token)).not.toBeNull();
    now += 2_000;
    expect(store.peek(token)).toBeNull();
  });

  it("purges expired sessions and keeps valid ones", () => {
    const expired = store.create(null);
    now += SESSION_IDLE_MS / 2;
    const valid = store.create(null);
    now += SESSION_IDLE_MS / 2 + 1;
    expect(store.purgeExpired()).toBe(1);
    expect(store.validate(valid)).not.toBeNull();
    expect(store.validate(expired)).toBeNull();
    expect(t.db.select().from(authSessions).all()).toHaveLength(1);
  });
});
