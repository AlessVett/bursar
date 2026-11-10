import type { AccountDetailResponse, AccountSummary } from "@bursar/shared";
import { describe, expect, it } from "vitest";
import {
  accountActionStates,
  deriveAlerts,
  isAccountTab,
  statusPill,
  stripeTone,
} from "./account-state";

const NOW = Date.parse("2026-11-09T09:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = "Europe/Rome";

function detail(
  account: Partial<AccountSummary> = {},
  connection: Partial<AccountDetailResponse["connection"]> = {},
): AccountDetailResponse {
  return {
    account: {
      id: 1,
      connectionId: 3,
      name: "Conto Smart",
      nickname: null,
      bankProduct: null,
      maskedIdentifier: "IT95 •••• •••• 0001",
      iban: null,
      last4: "0001",
      currency: "EUR",
      cashAccountType: "CACC",
      status: "active",
      balance: null,
      net30d: { inMinor: 0, outMinor: 0, netMinor: 0 },
      daily30d: [],
      lastSyncedAt: NOW - HOUR,
      lastSyncError: null,
      rateLimitedUntil: null,
      syncInProgress: false,
      ...account,
    },
    connection: {
      id: 3,
      bankName: "Banca Esempio",
      country: "IT",
      hasLogo: false,
      status: "active",
      validUntil: NOW + 88 * DAY,
      createdAt: NOW - 100 * DAY,
      renewedAt: null,
      lastError: null,
      ...connection,
    },
    syncRuns: [],
    transactionCount: 0,
  };
}

const ids = (d: AccountDetailResponse): string[] =>
  deriveAlerts(d, NOW, ZONE).map((alert) => alert.id);

describe("isAccountTab", () => {
  it("accepts the three tabs and nothing else", () => {
    expect(["overview", "transactions", "connection"].every(isAccountTab)).toBe(true);
    expect(["", "Overview", "settings", "transactions "].some(isAccountTab)).toBe(false);
  });
});

describe("deriveAlerts", () => {
  it("returns nothing for a healthy account", () => {
    expect(ids(detail())).toEqual([]);
  });

  it("maps the connection states to danger alerts with a renew action", () => {
    for (const [status, id] of [
      ["expired", "expired"],
      ["revoked", "revoked"],
      ["error", "connectionError"],
    ] as const) {
      const [alert] = deriveAlerts(detail({}, { status }), NOW, ZONE);
      expect(alert).toMatchObject({ id, tone: "danger", action: { kind: "run", action: "renew" } });
    }
  });

  it("counts calendar days for an expiring consent and turns danger within three days", () => {
    const at = (days: number) =>
      deriveAlerts(detail({}, { status: "expiring", validUntil: NOW + days * DAY }), NOW, ZONE)[0];
    expect(at(9)).toMatchObject({ id: "expiring", tone: "warning", values: { count: 9 } });
    expect(at(3)).toMatchObject({ id: "expiring", tone: "danger", values: { count: 3 } });
    expect(at(1)).toMatchObject({ id: "expiring", tone: "danger", values: { count: 1 } });
    expect(
      deriveAlerts(detail({}, { status: "expiring", validUntil: NOW + 2 * HOUR }), NOW, ZONE)[0],
    ).toMatchObject({ id: "expiringToday", tone: "danger" });
  });

  it("gives a removed account that single alert and nothing else", () => {
    const removed = detail(
      { status: "removed", lastSyncError: { code: "X", at: NOW } },
      { status: "revoked" },
    );
    expect(ids(removed)).toEqual(["removed"]);
    expect(deriveAlerts(removed, NOW, ZONE)[0]?.action).toEqual({ kind: "accounts" });
  });

  it("flags unavailable and disabled accounts", () => {
    expect(ids(detail({ status: "unavailable" }))).toEqual(["unavailable"]);
    expect(deriveAlerts(detail({ status: "disabled" }), NOW, ZONE)[0]).toMatchObject({
      id: "disabled",
      action: { kind: "run", action: "enable" },
    });
  });

  it("prefers the rate limit to a failed update and ignores a limit in the past", () => {
    const failed = { code: "ASPSP_RATE_LIMIT_EXCEEDED", at: NOW - HOUR };
    expect(ids(detail({ rateLimitedUntil: NOW + HOUR, lastSyncError: failed }))).toEqual([
      "rateLimited",
    ]);
    expect(ids(detail({ rateLimitedUntil: NOW - HOUR, lastSyncError: failed }))).toEqual([
      "syncFailed",
    ]);
  });

  it("does not repeat a consent problem as a failed update", () => {
    const failed = { code: "EXPIRED_SESSION", at: NOW - HOUR };
    expect(ids(detail({ lastSyncError: failed }, { status: "expired" }))).toEqual(["expired"]);
    expect(ids(detail({ lastSyncError: failed }, { status: "expiring" }))).toEqual([
      "expiring",
      "syncFailed",
    ]);
  });

  it("tells a never-synced account from one whose first sync is running", () => {
    expect(ids(detail({ lastSyncedAt: null }))).toEqual(["neverSynced"]);
    expect(ids(detail({ lastSyncedAt: null, syncInProgress: true }))).toEqual(["firstSync"]);
    expect(
      deriveAlerts(detail({ lastSyncedAt: null, syncInProgress: true }), NOW, ZONE)[0]?.action,
    ).toBeNull();
  });
});

describe("stripeTone and statusPill", () => {
  it("follows the connection, then downgrades a healthy one for account problems", () => {
    expect(stripeTone(detail())).toBe("positive");
    expect(stripeTone(detail({}, { status: "expiring" }))).toBe("warning");
    expect(stripeTone(detail({}, { status: "revoked" }))).toBe("danger");
    expect(stripeTone(detail({ status: "unavailable" }))).toBe("warning");
    expect(stripeTone(detail({ lastSyncError: { code: null, at: NOW } }))).toBe("warning");
    expect(stripeTone(detail({ status: "disabled" }, { status: "expired" }))).toBe("neutral");
    expect(stripeTone(detail({ status: "removed" }))).toBe("neutral");
  });

  it("shows one pill: the account state when it is not active, else the connection state", () => {
    expect(statusPill(detail())).toEqual({ tone: "positive", key: "active" });
    expect(statusPill(detail({}, { status: "expiring" }))).toEqual({
      tone: "warning",
      key: "expiring",
    });
    expect(statusPill(detail({ status: "disabled" }, { status: "expired" }))).toEqual({
      tone: "neutral",
      key: "disabled",
    });
    expect(statusPill(detail({ status: "unavailable" }))).toEqual({
      tone: "warning",
      key: "unavailable",
    });
  });
});

describe("accountActionStates", () => {
  const actions = (d: AccountDetailResponse) =>
    accountActionStates(d, NOW).map(
      (s) => `${s.action}${s.primary ? "*" : ""}${s.blockedKey ? "!" : ""}`,
    );

  it("makes sync primary on an active connection and keeps renew and disconnect", () => {
    expect(actions(detail())).toEqual(["sync*", "renew", "disconnect"]);
  });

  it("makes renew primary when the consent is expiring", () => {
    expect(accountActionStates(detail({}, { status: "expiring" }), NOW)[0]).toMatchObject({
      action: "renew",
      primary: true,
      blockedKey: null,
    });
  });

  it("blocks sync with the reason from the state machine when the consent ended", () => {
    const states = accountActionStates(detail({}, { status: "expired" }), NOW);
    expect(states.map((s) => s.action)).toEqual(["renew", "sync", "disconnect"]);
    expect(states.find((s) => s.action === "sync")?.blockedKey).toBeTruthy();
    expect(states[0]).toMatchObject({ action: "renew", primary: true, blockedKey: null });
  });

  it("blocks sync while syncing, while rate limited and on an unavailable account", () => {
    const reason = (d: AccountDetailResponse) =>
      accountActionStates(d, NOW).find((s) => s.action === "sync")?.blockedKey;
    expect(reason(detail({ syncInProgress: true }))).toBe("account.actions.blocked.syncing");
    expect(reason(detail({ rateLimitedUntil: NOW + HOUR }))).toBe(
      "account.actions.blocked.rateLimited",
    );
    expect(reason(detail({ rateLimitedUntil: NOW - HOUR }))).toBeNull();
    expect(reason(detail({ status: "unavailable" }))).toBe("account.actions.blocked.unavailable");
  });

  it("puts enable first for a disabled account and blocks its sync", () => {
    const states = accountActionStates(detail({ status: "disabled" }), NOW);
    expect(states[0]).toMatchObject({ action: "enable", primary: true, blockedKey: null });
    expect(states.find((s) => s.action === "sync")).toMatchObject({
      primary: false,
      blockedKey: "account.actions.blocked.disabled",
    });
  });

  it("has no actions for a removed account", () => {
    expect(actions(detail({ status: "removed" }))).toEqual([]);
  });
});
