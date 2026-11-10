import { effectiveConnectionStatus, localTimeOfDay, toLocalDate } from "@bursar/shared";
import type { Logger } from "pino";
import type { JobQueue } from "../jobs/queue";
import type { ScheduledTask } from "../scheduler";
import type { SettingsStore } from "../settings/store";
import type { FinanceRepository } from "./repository";
import { enqueueAccountSync } from "./sync";

/**
 * Once per local day, at or after `settings.dailySyncTime`, queues a background sync for each
 * active account of a usable connection. The scheduler ticks every minute; the account's
 * `last_scheduled_sync_day` makes the task idempotent within a day. The background cap is
 * enforced by the job, not here.
 */
export function dailySyncTask(deps: {
  repo: FinanceRepository;
  queue: JobQueue;
  settings: SettingsStore;
  timezone: string;
  logger: Logger;
}): ScheduledTask {
  return {
    name: "bank-daily-sync",
    run(now: Date) {
      const at = now.getTime();
      // "HH:MM" strings compare chronologically.
      if (localTimeOfDay(at, deps.timezone) < deps.settings.get().dailySyncTime) return;
      const today = toLocalDate(at, deps.timezone);
      let queued = 0;
      for (const connection of deps.repo.listConnections()) {
        if (connection.removedAt !== null) continue;
        const status = effectiveConnectionStatus(
          connection.status,
          connection.validUntil,
          at,
          deps.timezone,
        );
        if (status !== "active" && status !== "expiring") continue;
        for (const account of deps.repo.listAccounts({
          connectionId: connection.id,
          statuses: ["active"],
        })) {
          if (account.lastScheduledSyncDay === today) continue;
          if (account.providerAccountUid === null) continue;
          // Not marked for the day: picked up on the first tick after the pause ends.
          if (account.rateLimitedUntil !== null && account.rateLimitedUntil > at) continue;
          enqueueAccountSync(deps.queue, account.id, "background");
          deps.repo.updateAccount(account.id, { lastScheduledSyncDay: today, updatedAt: at });
          queued += 1;
        }
      }
      if (queued > 0) deps.logger.info({ queued, day: today }, "Daily bank sync queued");
    },
  };
}
