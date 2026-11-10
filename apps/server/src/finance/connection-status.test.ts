import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSyncHarness,
  DAY_MS,
  eventsOf,
  insertConnection,
  SYNC_TEST_TIMEZONE,
  type SyncHarness,
} from "../test/sync-fixture";
import { type ConnectionStatusDeps, markConnectionEnded } from "./connection-status";

describe("markConnectionEnded", () => {
  let h: SyncHarness;
  let connectionId: number;

  beforeEach(() => {
    h = createSyncHarness();
    connectionId = insertConnection(h.t.sqlite, { now: h.clock.now, aspspName: "Banca Esempio" });
  });
  afterEach(() => h.dispose());

  function deps(): ConnectionStatusDeps {
    return {
      repo: h.repo,
      notifications: h.notifications,
      bus: h.bus,
      now: () => h.clock.now,
      timezone: SYNC_TEST_TIMEZONE,
    };
  }

  it("marks a connection expired, raises consent_expired and publishes the change", () => {
    markConnectionEnded(deps(), connectionId, "expired", {
      code: "EXPIRED_SESSION",
      message: "401 EXPIRED_SESSION: Session expired",
    });
    expect(h.repo.getConnection(connectionId)).toMatchObject({
      status: "expired",
      lastErrorCode: "EXPIRED_SESSION",
      lastErrorMessage: "401 EXPIRED_SESSION: Session expired",
      lastErrorAt: h.clock.now,
    });
    const items = h.notifications.list(10).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      event: "consent_expired",
      params: { bankName: "Banca Esempio" },
      link: "/accounts",
    });
    expect(eventsOf(h.events, "connection.updated")).toEqual([
      { type: "connection.updated", connectionId, status: "expired" },
    ]);
  });

  it.each([{ status: "revoked" as const }, { status: "error" as const }])(
    "marks a connection $status and raises connection_error",
    ({ status }) => {
      markConnectionEnded(deps(), connectionId, status, {
        code: "REVOKED_SESSION",
        message: "401 REVOKED_SESSION: Session revoked",
      });
      expect(h.repo.getConnection(connectionId)).toMatchObject({
        status,
        lastErrorCode: "REVOKED_SESSION",
        lastErrorAt: h.clock.now,
      });
      const items = h.notifications.list(10).items;
      expect(items.map((item) => item.event)).toEqual(["connection_error"]);
      expect(items[0]).toMatchObject({ params: { bankName: "Banca Esempio" }, link: "/accounts" });
      expect(eventsOf(h.events, "connection.updated")).toEqual([
        { type: "connection.updated", connectionId, status },
      ]);
    },
  );

  it("does nothing when the stored status already matches", () => {
    markConnectionEnded(deps(), connectionId, "expired");
    h.clock.now += DAY_MS;
    markConnectionEnded(deps(), connectionId, "expired", {
      code: "EXPIRED_SESSION",
      message: "401 EXPIRED_SESSION: Session expired",
    });
    expect(h.notifications.list(10).items).toHaveLength(1);
    expect(eventsOf(h.events, "connection.updated")).toHaveLength(1);
    expect(h.repo.getConnection(connectionId)?.lastErrorCode).toBeNull();
  });

  it("ignores unknown and removed connections", () => {
    const removed = insertConnection(h.t.sqlite, { now: h.clock.now, removedAt: h.clock.now });
    markConnectionEnded(deps(), 9_999, "error");
    markConnectionEnded(deps(), removed, "error");
    expect(h.repo.getConnection(removed)?.status).toBe("active");
    expect(h.notifications.list(10).items).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("leaves a connection alone once it holds another session than the one that failed", () => {
    const renewed = h.repo.getConnection(connectionId)?.providerSessionId ?? "";
    markConnectionEnded(
      deps(),
      connectionId,
      "expired",
      { code: "EXPIRED_SESSION", message: "401 EXPIRED_SESSION: Session expired" },
      "an-older-session",
    );
    expect(h.repo.getConnection(connectionId)).toMatchObject({
      status: "active",
      lastErrorCode: null,
    });
    expect(h.notifications.list(10).items).toHaveLength(0);
    expect(h.events).toHaveLength(0);

    markConnectionEnded(deps(), connectionId, "expired", undefined, renewed);
    expect(h.repo.getConnection(connectionId)?.status).toBe("expired");
  });

  it("stores no error details when none is given", () => {
    markConnectionEnded(deps(), connectionId, "expired");
    expect(h.repo.getConnection(connectionId)).toMatchObject({
      status: "expired",
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
    });
  });
});
