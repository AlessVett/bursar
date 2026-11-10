import {
  type AccountSummary,
  type ConnectionStatus,
  type ConnectionSummary,
  toLocalDate,
} from "@bursar/shared";

export type ConnectionAction = "renew" | "sync" | "disconnect";

export interface ConnectionActionPlan {
  /** The natural next step; the card shows it as a button. `null` when nothing applies. */
  primary: ConnectionAction | null;
  /** Everything the owner may do, primary first. */
  allowed: ConnectionAction[];
  /** Actions the owner expects but cannot take now, with the i18n key of the reason (UX doc §7 level 2). */
  blocked: Partial<Record<ConnectionAction, string>>;
}

const SYNC_BLOCKED_KEYS: Record<"expired" | "revoked" | "error", string> = {
  expired: "connection.blocked.syncExpired",
  revoked: "connection.blocked.syncRevoked",
  error: "connection.blocked.syncError",
};

/**
 * The state machine of a connection with a primary action (UX doc §10): healthy connections
 * sync, connections that are ending or ended renew; syncing an ended connection is blocked with
 * a reason, disconnecting is always possible.
 */
export function connectionActions(status: ConnectionStatus): ConnectionActionPlan {
  switch (status) {
    case "active":
      return { primary: "sync", allowed: ["sync", "renew", "disconnect"], blocked: {} };
    case "expiring":
      return { primary: "renew", allowed: ["renew", "sync", "disconnect"], blocked: {} };
    case "expired":
    case "revoked":
    case "error":
      return {
        primary: "renew",
        allowed: ["renew", "disconnect"],
        blocked: { sync: SYNC_BLOCKED_KEYS[status] },
      };
  }
}

export function connectionTone(status: ConnectionStatus): "positive" | "warning" | "danger" {
  if (status === "active") return "positive";
  if (status === "expiring") return "warning";
  return "danger";
}

/** True for the states that need the owner: the consent is ending, ended, revoked or failing. */
export function needsAction(status: ConnectionStatus): boolean {
  return status !== "active";
}

export function countNeedingAction(connections: readonly { status: ConnectionStatus }[]): number {
  return connections.filter((connection) => needsAction(connection.status)).length;
}

/** Sort key: broken connections first, then expiring ones, then healthy ones. */
export function attentionRank(status: ConnectionStatus): number {
  if (status === "active") return 2;
  if (status === "expiring") return 1;
  return 0;
}

export interface SyncBlock {
  /** i18n key of the reason. */
  key: string;
  /** Epoch ms when a rate limit ends, for the `{{when}}` of the message. */
  retryAt?: number;
}

/**
 * Why a manual sync of this account cannot start right now, or `null` when it can. The
 * connection's state wins over the account's, then the rate limit, then a sync already running.
 */
export function accountSyncBlock(
  account: Pick<AccountSummary, "status" | "rateLimitedUntil" | "syncInProgress">,
  connectionStatus: ConnectionStatus,
  now: number,
): SyncBlock | null {
  const connectionReason = connectionActions(connectionStatus).blocked.sync;
  if (connectionReason) return { key: connectionReason };
  if (account.status === "disabled") return { key: "accounts.blocked.disabled" };
  if (account.status === "unavailable") return { key: "accounts.blocked.unavailable" };
  if (account.rateLimitedUntil !== null && account.rateLimitedUntil > now) {
    return { key: "accounts.blocked.rateLimited", retryAt: account.rateLimitedUntil };
  }
  if (account.syncInProgress) return { key: "accounts.blocked.running" };
  return null;
}

/**
 * The positive state: at least one active account, every connection active, and every active
 * account updated on the owner's current local day.
 */
export function allUpdatedToday(
  connections: readonly ConnectionSummary[],
  now: number,
  timeZone: string,
): boolean {
  const today = toLocalDate(now, timeZone);
  const active = connections
    .flatMap((connection) => connection.accounts)
    .filter((account) => account.status === "active");
  if (active.length === 0) return false;
  if (!connections.every((connection) => connection.status === "active")) return false;
  return active.every(
    (account) =>
      account.lastSyncedAt !== null && toLocalDate(account.lastSyncedAt, timeZone) === today,
  );
}

/** Two letters for the logo placeholder: first letters of the first two words, or the first two letters. */
export function bankInitials(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const first = words[0] ?? "";
  const second = words[1] ?? "";
  if (first === "") return "?";
  if (second === "") return first.slice(0, 2).toUpperCase();
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

/** The redirect after `renew` goes to the bank: only http(s) URLs are followed. */
export function isSafeRedirect(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** A count in the grouping of the locale (`1,234` in en-GB, `12.400` in it-IT). */
export function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}
