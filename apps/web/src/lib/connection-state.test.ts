import type { ConnectionStatus } from "@bursar/shared";
import { describe, expect, it } from "vitest";
import { accountFixture, connectionFixture, DAY, FIXED_NOW, HOUR } from "../test/accounts-fixtures";
import {
  accountSyncBlock,
  allUpdatedToday,
  attentionRank,
  bankInitials,
  type ConnectionActionPlan,
  connectionActions,
  connectionTone,
  countNeedingAction,
  formatCount,
  isSafeRedirect,
  needsAction,
} from "./connection-state";

const ZONE = "Europe/Rome";

describe("connectionActions", () => {
  const table: [ConnectionStatus, ConnectionActionPlan][] = [
    ["active", { primary: "sync", allowed: ["sync", "renew", "disconnect"], blocked: {} }],
    ["expiring", { primary: "renew", allowed: ["renew", "sync", "disconnect"], blocked: {} }],
    [
      "expired",
      {
        primary: "renew",
        allowed: ["renew", "disconnect"],
        blocked: { sync: "connection.blocked.syncExpired" },
      },
    ],
    [
      "revoked",
      {
        primary: "renew",
        allowed: ["renew", "disconnect"],
        blocked: { sync: "connection.blocked.syncRevoked" },
      },
    ],
    [
      "error",
      {
        primary: "renew",
        allowed: ["renew", "disconnect"],
        blocked: { sync: "connection.blocked.syncError" },
      },
    ],
  ];

  it.each(table)("plans the actions of a %s connection", (status, expected) => {
    expect(connectionActions(status)).toEqual(expected);
  });

  it("never allows an action it also blocks, and always allows disconnecting", () => {
    for (const [status] of table) {
      const plan = connectionActions(status);
      for (const blocked of Object.keys(plan.blocked)) {
        expect(plan.allowed).not.toContain(blocked);
      }
      expect(plan.allowed).toContain("disconnect");
      expect(plan.allowed).toContain(plan.primary);
    }
  });
});

describe("connectionTone, needsAction and attentionRank", () => {
  it("maps every status to a tone", () => {
    expect(connectionTone("active")).toBe("positive");
    expect(connectionTone("expiring")).toBe("warning");
    expect(connectionTone("expired")).toBe("danger");
    expect(connectionTone("revoked")).toBe("danger");
    expect(connectionTone("error")).toBe("danger");
  });

  it("counts the connections that need the owner's attention", () => {
    expect(needsAction("active")).toBe(false);
    for (const status of ["expiring", "expired", "revoked", "error"] as const) {
      expect(needsAction(status)).toBe(true);
    }
    expect(
      countNeedingAction([
        { status: "active" },
        { status: "expiring" },
        { status: "revoked" },
        { status: "active" },
      ]),
    ).toBe(2);
    expect(countNeedingAction([])).toBe(0);
  });

  it("ranks broken connections before expiring ones before healthy ones", () => {
    const ranked = (["active", "expiring", "error", "expired", "revoked"] as const)
      .map((status) => ({ status, rank: attentionRank(status) }))
      .sort((a, b) => a.rank - b.rank);
    expect(ranked.map((item) => item.status)).toEqual([
      "error",
      "expired",
      "revoked",
      "expiring",
      "active",
    ]);
  });
});

describe("accountSyncBlock", () => {
  const healthy = accountFixture();

  it("does not block a healthy account of an active connection", () => {
    expect(accountSyncBlock(healthy, "active", FIXED_NOW)).toBeNull();
    expect(accountSyncBlock(healthy, "expiring", FIXED_NOW)).toBeNull();
  });

  it("blocks by the state of the connection first", () => {
    const disabled = accountFixture({ status: "disabled" });
    expect(accountSyncBlock(disabled, "expired", FIXED_NOW)).toEqual({
      key: "connection.blocked.syncExpired",
    });
    expect(accountSyncBlock(healthy, "revoked", FIXED_NOW)).toEqual({
      key: "connection.blocked.syncRevoked",
    });
  });

  it("blocks disabled and unavailable accounts", () => {
    expect(accountSyncBlock(accountFixture({ status: "disabled" }), "active", FIXED_NOW)).toEqual({
      key: "accounts.blocked.disabled",
    });
    expect(
      accountSyncBlock(accountFixture({ status: "unavailable" }), "active", FIXED_NOW),
    ).toEqual({ key: "accounts.blocked.unavailable" });
  });

  it("reports the rate limit with its retry time, but only while it lasts", () => {
    const limited = accountFixture({ rateLimitedUntil: FIXED_NOW + 5 * HOUR });
    expect(accountSyncBlock(limited, "active", FIXED_NOW)).toEqual({
      key: "accounts.blocked.rateLimited",
      retryAt: FIXED_NOW + 5 * HOUR,
    });
    expect(accountSyncBlock(limited, "active", FIXED_NOW + 6 * HOUR)).toBeNull();
  });

  it("reports a sync that is already running", () => {
    expect(accountSyncBlock(accountFixture({ syncInProgress: true }), "active", FIXED_NOW)).toEqual(
      { key: "accounts.blocked.running" },
    );
  });
});

describe("allUpdatedToday", () => {
  const fresh = accountFixture({ lastSyncedAt: FIXED_NOW - HOUR });

  it("is true when every active account of healthy connections was updated today", () => {
    expect(allUpdatedToday([connectionFixture({ accounts: [fresh] })], FIXED_NOW, ZONE)).toBe(true);
  });

  it("is false when one active account is stale or has never synced", () => {
    const stale = accountFixture({ id: 2, lastSyncedAt: FIXED_NOW - 2 * DAY });
    const never = accountFixture({ id: 3, lastSyncedAt: null });
    expect(
      allUpdatedToday([connectionFixture({ accounts: [fresh, stale] })], FIXED_NOW, ZONE),
    ).toBe(false);
    expect(
      allUpdatedToday([connectionFixture({ accounts: [fresh, never] })], FIXED_NOW, ZONE),
    ).toBe(false);
  });

  it("ignores disabled accounts but needs every connection to be active and one account", () => {
    const disabledStale = accountFixture({ id: 2, status: "disabled", lastSyncedAt: null });
    expect(
      allUpdatedToday([connectionFixture({ accounts: [fresh, disabledStale] })], FIXED_NOW, ZONE),
    ).toBe(true);
    expect(
      allUpdatedToday(
        [connectionFixture({ status: "expiring", accounts: [fresh] })],
        FIXED_NOW,
        ZONE,
      ),
    ).toBe(false);
    expect(allUpdatedToday([], FIXED_NOW, ZONE)).toBe(false);
    expect(
      allUpdatedToday([connectionFixture({ accounts: [disabledStale] })], FIXED_NOW, ZONE),
    ).toBe(false);
  });

  it("uses the owner's local day, not UTC", () => {
    // 2026-11-09 23:30 in Rome is 22:30 UTC; an update at 00:30 Rome the same night is "today".
    const lateEvening = Date.UTC(2026, 10, 9, 22, 30, 0);
    const justAfterMidnight = accountFixture({ lastSyncedAt: Date.UTC(2026, 10, 8, 23, 30, 0) });
    expect(
      allUpdatedToday([connectionFixture({ accounts: [justAfterMidnight] })], lateEvening, ZONE),
    ).toBe(true);
  });
});

describe("small helpers", () => {
  it("builds the initials shown when a bank has no logo", () => {
    expect(bankInitials("Northwind Bank")).toBe("NB");
    expect(bankInitials("Banca Esempio")).toBe("BE");
    expect(bankInitials("Revolut")).toBe("RE");
    expect(bankInitials("Crédit Agricole")).toBe("CA");
    expect(bankInitials("   ")).toBe("?");
  });

  it("follows only http and https redirects", () => {
    expect(isSafeRedirect("https://bank.example.test/authorize?x=1")).toBe(true);
    expect(isSafeRedirect("http://127.0.0.1:8080/api/banks/callback?state=a")).toBe(true);
    expect(isSafeRedirect("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirect("data:text/html,x")).toBe(false);
    expect(isSafeRedirect("/relative")).toBe(false);
    expect(isSafeRedirect("")).toBe(false);
  });

  it("formats counts with the grouping of the locale", () => {
    expect(formatCount("en-GB", 1234)).toBe("1,234");
    expect(formatCount("it-IT", 12400)).toBe("12.400");
    expect(formatCount("en-GB", 0)).toBe("0");
  });
});
