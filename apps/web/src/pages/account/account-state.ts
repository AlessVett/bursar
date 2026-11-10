import type { AccountDetailResponse } from "@bursar/shared";
import {
  type ConnectionAction,
  connectionActions,
  connectionTone,
} from "../../lib/connection-state";
import { consentUrgency } from "../../lib/thresholds";

export type AccountTab = "overview" | "transactions" | "connection";

export const ACCOUNT_TABS: readonly AccountTab[] = ["overview", "transactions", "connection"];

export function isAccountTab(value: string): value is AccountTab {
  return (ACCOUNT_TABS as readonly string[]).includes(value);
}

/** What the page can do for the account right now. */
export type AccountRunAction = "sync" | "renew" | "enable";

export type StripeTone = "positive" | "warning" | "danger" | "neutral";

/**
 * Colour of the 6 px stripe on top of the hero. A removed or disabled account is neutral; otherwise
 * the connection state decides, and an unavailable account or a failed last update downgrades a
 * healthy connection to a warning.
 */
export function stripeTone(detail: AccountDetailResponse): StripeTone {
  const { account, connection } = detail;
  if (account.status === "removed" || account.status === "disabled") return "neutral";
  const tone = connectionTone(connection.status);
  if (tone !== "positive") return tone;
  return account.status === "unavailable" || account.lastSyncError !== null
    ? "warning"
    : "positive";
}

/** The single status pill of the hero: the account state when it is not active, else the connection state. */
export function statusPill(detail: AccountDetailResponse): {
  tone: "positive" | "warning" | "danger" | "neutral";
  key: string;
} {
  const { account, connection } = detail;
  if (account.status === "removed") return { tone: "neutral", key: "removed" };
  if (account.status === "disabled") return { tone: "neutral", key: "disabled" };
  if (account.status === "unavailable") return { tone: "warning", key: "unavailable" };
  return { tone: connectionTone(connection.status), key: connection.status };
}

export type AlertId =
  | "removed"
  | "expired"
  | "revoked"
  | "connectionError"
  | "expiringToday"
  | "expiring"
  | "unavailable"
  | "disabled"
  | "syncFailed"
  | "rateLimited"
  | "neverSynced"
  | "firstSync";

export type AlertTone = "danger" | "warning" | "info";

export type AlertAction =
  | { kind: "tab"; tab: AccountTab }
  | { kind: "run"; action: AccountRunAction }
  | { kind: "accounts" };

export interface AccountAlert {
  id: AlertId;
  tone: AlertTone;
  /** What the call to action does; null for an alert without one. */
  action: AlertAction | null;
  values: { bank: string; count?: number; at?: number; code?: string | null };
}

/**
 * The contextual alerts of the Overview tab, most urgent first. An empty list means "All good".
 * A removed account has one alert only; reasons that the connection state already explains are not
 * repeated for the account (a failed update on an expired consent, for example).
 */
export function deriveAlerts(
  detail: AccountDetailResponse,
  now: number,
  timeZone: string,
): AccountAlert[] {
  const { account, connection } = detail;
  const bank = connection.bankName;
  if (account.status === "removed") {
    return [{ id: "removed", tone: "info", action: { kind: "accounts" }, values: { bank } }];
  }

  const renew: AlertAction = { kind: "run", action: "renew" };
  const alerts: AccountAlert[] = [];
  switch (connection.status) {
    case "expired":
      alerts.push({ id: "expired", tone: "danger", action: renew, values: { bank } });
      break;
    case "revoked":
      alerts.push({ id: "revoked", tone: "danger", action: renew, values: { bank } });
      break;
    case "error":
      alerts.push({ id: "connectionError", tone: "danger", action: renew, values: { bank } });
      break;
    case "expiring": {
      const { urgency, daysLeft } = consentUrgency(connection.validUntil, now, timeZone);
      alerts.push(
        daysLeft <= 0
          ? { id: "expiringToday", tone: "danger", action: renew, values: { bank } }
          : {
              id: "expiring",
              tone: urgency === "danger" ? "danger" : "warning",
              action: renew,
              values: { bank, count: daysLeft },
            },
      );
      break;
    }
    case "active":
      break;
  }

  if (account.status === "unavailable") {
    alerts.push({
      id: "unavailable",
      tone: "warning",
      action: { kind: "tab", tab: "connection" },
      values: { bank },
    });
  }
  if (account.status === "disabled") {
    alerts.push({
      id: "disabled",
      tone: "info",
      action: { kind: "run", action: "enable" },
      values: { bank },
    });
  }

  const reachable = connection.status === "active" || connection.status === "expiring";
  if (account.status === "active" && reachable) {
    const rateLimited = account.rateLimitedUntil !== null && account.rateLimitedUntil > now;
    if (rateLimited) {
      alerts.push({
        id: "rateLimited",
        tone: "info",
        action: { kind: "tab", tab: "connection" },
        values: { bank, at: account.rateLimitedUntil ?? undefined },
      });
    } else if (account.lastSyncError !== null) {
      alerts.push({
        id: "syncFailed",
        tone: "warning",
        action: { kind: "run", action: "sync" },
        values: { bank, code: account.lastSyncError.code },
      });
    } else if (account.lastSyncedAt === null) {
      alerts.push(
        account.syncInProgress
          ? { id: "firstSync", tone: "info", action: null, values: { bank } }
          : {
              id: "neverSynced",
              tone: "info",
              action: { kind: "run", action: "sync" },
              values: { bank },
            },
      );
    }
  }
  return alerts;
}

export type AccountActionKind = ConnectionAction | "enable";

export interface AccountActionState {
  action: AccountActionKind;
  primary: boolean;
  /** i18n key of the reason the action is unavailable right now; null when it can run. */
  blockedKey: string | null;
}

/**
 * Actions for the account, primary first: the connection state machine (`connectionActions`) plus
 * "enable" for a disabled account, with the reason when one is blocked. A removed account has none.
 */
export function accountActionStates(
  detail: AccountDetailResponse,
  now: number,
): AccountActionState[] {
  const { account, connection } = detail;
  if (account.status === "removed") return [];
  const base = connectionActions(connection.status);
  const primary: AccountActionKind | null = account.status === "disabled" ? "enable" : base.primary;

  const syncBlocked = (): string | null => {
    if (base.blocked.sync !== undefined) return base.blocked.sync;
    if (account.status === "disabled") return "account.actions.blocked.disabled";
    if (account.status === "unavailable") return "account.actions.blocked.unavailable";
    if (account.syncInProgress) return "account.actions.blocked.syncing";
    if (account.rateLimitedUntil !== null && account.rateLimitedUntil > now) {
      return "account.actions.blocked.rateLimited";
    }
    return null;
  };

  const kinds: AccountActionKind[] = account.status === "disabled" ? ["enable"] : [];
  for (const action of ["sync", "renew", "disconnect"] as const) {
    if (
      action === base.primary ||
      base.allowed.includes(action) ||
      base.blocked[action] !== undefined
    ) {
      kinds.push(action);
    }
  }
  const states = kinds.map((action) => ({
    action,
    primary: action === primary,
    blockedKey:
      action === "sync"
        ? syncBlocked()
        : action === "enable"
          ? null
          : (base.blocked[action] ?? null),
  }));
  return states.sort((a, b) => Number(b.primary) - Number(a.primary));
}
