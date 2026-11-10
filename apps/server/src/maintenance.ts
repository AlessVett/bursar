import type { Logger } from "pino";
import type { FailureLimiter } from "./auth/rate-limit";
import type { SessionStore } from "./auth/sessions";
import type { JobQueue } from "./jobs/queue";
import type { ScheduledTask } from "./scheduler";

export const FINISHED_JOB_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface MaintenanceDeps {
  queue: JobQueue;
  sessions: SessionStore;
  limiters: readonly FailureLimiter[];
  logger: Logger;
  /** Extra housekeeping from later features; `run` returns how many rows or entries it removed. */
  cleanups?: ReadonlyArray<{ name: string; run(): number }>;
}

export function maintenanceTask(deps: MaintenanceDeps): ScheduledTask {
  const { queue, sessions, limiters, logger, cleanups = [] } = deps;
  return {
    name: "maintenance",
    run: () => {
      // No `queue.recoverStale` here: a running job may be in flight in this very process (a long
      // sync or a backup upload). Boot-time `recoverStale(0)` in server.ts handles crashes.
      const counts: Record<string, number> = {
        sessionsPurged: sessions.purgeExpired(),
        limiterEntriesSwept: limiters.reduce((total, limiter) => total + limiter.sweep(), 0),
        finishedJobsPurged: queue.purgeFinished(FINISHED_JOB_RETENTION_MS),
      };
      for (const cleanup of cleanups) {
        try {
          counts[cleanup.name] = cleanup.run();
        } catch (error) {
          // One failing cleanup must not stop the others (or the next tick).
          logger.warn(
            {
              cleanup: cleanup.name,
              error: error instanceof Error ? error.message : String(error),
            },
            "Maintenance cleanup failed",
          );
        }
      }
      if (Object.values(counts).some((count) => count > 0)) {
        logger.info(counts, "Maintenance done");
      }
    },
  };
}
