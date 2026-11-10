import { localTimeOfDay, startOfLocalDay, toLocalDate } from "@bursar/shared";
import { and, eq, gte } from "drizzle-orm";
import type { BursarDb } from "../db";
import { backupRuns } from "../db/schema";
import type { JobQueue } from "../jobs/queue";
import { BACKUP_DEDUPE_KEY, BACKUP_JOB, backupPayloadSchema, parsePayload } from "../jobs/types";
import { type JobHandler, PermanentJobError } from "../jobs/worker";
import type { ScheduledTask } from "../scheduler";
import type { SettingsStore } from "../settings/store";
import { BackupInProgressError, type BackupService } from "./service";

export const NIGHTLY_BACKUP_TASK = "nightly-backup";

/**
 * Handles `backup.run` jobs. A failed backup is recorded by the service and is not an error
 * here (the queue does not retry it: the next night does); a second run in progress is.
 */
export function backupJobHandler(service: BackupService): JobHandler {
  return async (job) => {
    const { trigger } = parsePayload(backupPayloadSchema, job);
    try {
      await service.run(trigger);
    } catch (error) {
      if (error instanceof BackupInProgressError) throw new PermanentJobError(error.message);
      throw error;
    }
  };
}

export interface BackupTaskDeps {
  queue: JobQueue;
  settings: SettingsStore;
  db: BursarDb;
  timezone: string;
  now?: () => number;
}

/**
 * Enqueues the nightly backup once per local day, at the first tick at or after
 * `settings.backupTime` (so a server that was down at that time catches up when it starts).
 * Nothing is enqueued when a scheduled run already started that local day, whatever its outcome
 * (a failed night is retried the next night, spec §9), or while a backup job is queued or running.
 */
export function backupTask(deps: BackupTaskDeps): ScheduledTask {
  return {
    name: NIGHTLY_BACKUP_TASK,
    run(date) {
      const now = deps.now ? deps.now() : date.getTime();
      if (localTimeOfDay(now, deps.timezone) < deps.settings.get().backupTime) return;
      const dayStart = startOfLocalDay(toLocalDate(now, deps.timezone), deps.timezone);
      const ranToday = deps.db
        .select({ id: backupRuns.id })
        .from(backupRuns)
        .where(and(eq(backupRuns.trigger, "scheduled"), gte(backupRuns.startedAt, dayStart)))
        .limit(1)
        .get();
      if (ranToday || deps.queue.findActive(BACKUP_DEDUPE_KEY)) return;
      deps.queue.enqueueUnique(
        BACKUP_JOB,
        BACKUP_DEDUPE_KEY,
        { trigger: "scheduled" },
        { maxAttempts: 1 },
      );
    },
  };
}
