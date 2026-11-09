import type { Logger } from "pino";
import type { SessionStore } from "./auth/sessions";
import type { JobQueue } from "./jobs/queue";
import type { ScheduledTask } from "./scheduler";

const STALE_JOB_MS = 10 * 60_000;

export function maintenanceTask(
  queue: JobQueue,
  sessions: SessionStore,
  logger: Logger,
): ScheduledTask {
  return {
    name: "maintenance",
    run: () => {
      const requeued = queue.recoverStale(STALE_JOB_MS);
      const purged = sessions.purgeExpired();
      if (requeued > 0 || purged > 0) logger.info({ requeued, purged }, "Maintenance done");
    },
  };
}
