import type { BackupRunResponse, BackupStatusResponse } from "@bursar/shared";
import { Hono } from "hono";
import type { AppEnv } from "../http/app";
import type { JobQueue } from "../jobs/queue";
import { BACKUP_DEDUPE_KEY, BACKUP_JOB } from "../jobs/types";
import type { BackupService } from "./service";

export interface BackupRoutesDeps {
  service: BackupService;
  queue: JobQueue;
}

const IN_PROGRESS = { error: "A backup is already running", code: "backup_in_progress" } as const;

/** Mounted at `/api/backups` behind the session. */
export function backupRoutes(deps: BackupRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/", (c) => c.json(deps.service.status() satisfies BackupStatusResponse));

  routes.post("/run", (c) => {
    if (deps.service.isRunning() || deps.queue.findActive(BACKUP_DEDUPE_KEY)) {
      return c.json(IN_PROGRESS, 409);
    }
    const { created } = deps.queue.enqueueUnique(
      BACKUP_JOB,
      BACKUP_DEDUPE_KEY,
      { trigger: "manual" },
      { maxAttempts: 1 },
    );
    if (!created) return c.json(IN_PROGRESS, 409);
    return c.json({ queued: true } satisfies BackupRunResponse, 202);
  });

  return routes;
}
