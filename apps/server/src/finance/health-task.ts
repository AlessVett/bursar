import {
  type AccountStatus,
  accountDisplayName,
  effectiveConnectionStatus,
  toLocalDate,
} from "@bursar/shared";
import { notificationKeys } from "../notifications/keys";
import type { NotificationService } from "../notifications/service";
import type { ScheduledTask } from "../scheduler";
import type { SettingsStore } from "../settings/store";
import type { FinanceRepository } from "./repository";

/** An account whose last success (or creation) is this old and that has a sync error since is failing. */
export const SYNC_FAILING_AFTER_MS = 48 * 3_600_000;

/**
 * Account statuses whose sync health is watched. An `unavailable` account (the bank reported it
 * missing or not accessible) is no longer synced, so it stays failing until the owner acts.
 */
export const SYNC_HEALTH_STATUSES: readonly AccountStatus[] = ["active", "unavailable"];

/**
 * The one "sync failing" rule shared by the health task and the Home alerts: no success (or, for
 * an account that never synced, no creation) for `SYNC_FAILING_AFTER_MS`, and a sync error
 * recorded after the last success. It reads the account's error state rather than its newest
 * run: retries consume the background cap, so on every day of an outage the newest run can be a
 * `daily_cap` skip (which leaves the error untouched), and a bank rate limit is a skipped run that
 * does record its error. A success clears the error.
 */
export function isSyncFailing(
  account: { lastSyncedAt: number | null; lastSyncErrorAt: number | null; createdAt: number },
  now: number,
): boolean {
  if (now - (account.lastSyncedAt ?? account.createdAt) < SYNC_FAILING_AFTER_MS) return false;
  return (
    account.lastSyncErrorAt !== null &&
    (account.lastSyncedAt === null || account.lastSyncErrorAt > account.lastSyncedAt)
  );
}

export interface SyncHealthTaskDeps {
  repo: FinanceRepository;
  notifications: NotificationService;
  /** The panel language names the account in the notification. */
  settings: SettingsStore;
  timezone: string;
  now: () => number;
}

/**
 * Raises `sync_failing` (spec §6.9: "sync failing for more than 2 days"). The key carries the
 * local date of the last success, so one outage raises once and a later outage raises again.
 */
export function syncHealthTask(deps: SyncHealthTaskDeps): ScheduledTask {
  return {
    name: "sync-health",
    run() {
      const now = deps.now();
      const locale = deps.settings.get().locale;
      const connections = new Map(deps.repo.listConnections().map((c) => [c.id, c]));
      for (const account of deps.repo.listAccounts({ statuses: SYNC_HEALTH_STATUSES })) {
        const connection = connections.get(account.connectionId);
        if (!connection || connection.removedAt !== null) continue;
        const status = effectiveConnectionStatus(
          connection.status,
          connection.validUntil,
          now,
          deps.timezone,
        );
        if (status !== "active" && status !== "expiring") continue;
        if (!isSyncFailing(account, now)) continue;
        const since =
          account.lastSyncedAt === null
            ? "never"
            : toLocalDate(account.lastSyncedAt, deps.timezone);
        deps.notifications.raise({
          event: "sync_failing",
          dedupeKey: notificationKeys.syncFailing(account.id, since),
          params: {
            accountName: accountDisplayName(account, locale),
            bankName: connection.aspspName,
          },
          link: `/accounts/${account.id}`,
        });
      }
    },
  };
}
