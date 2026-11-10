import { accountDisplayName, effectiveConnectionStatus, toLocalDate } from "@bursar/shared";
import { notificationKeys } from "../notifications/keys";
import type { NotificationService } from "../notifications/service";
import type { ScheduledTask } from "../scheduler";
import type { SettingsStore } from "../settings/store";
import type { FinanceRepository } from "./repository";

/** An account whose last success (or creation) is this old and whose latest run failed is failing. */
export const SYNC_FAILING_AFTER_MS = 48 * 3_600_000;

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
      for (const account of deps.repo.listAccounts({ statuses: ["active"] })) {
        const connection = connections.get(account.connectionId);
        if (!connection || connection.removedAt !== null) continue;
        const status = effectiveConnectionStatus(
          connection.status,
          connection.validUntil,
          now,
          deps.timezone,
        );
        if (status !== "active" && status !== "expiring") continue;
        if (now - (account.lastSyncedAt ?? account.createdAt) < SYNC_FAILING_AFTER_MS) continue;
        const latest = deps.repo.listSyncRuns(account.id, 1)[0];
        if (latest?.status !== "failed") continue;
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
