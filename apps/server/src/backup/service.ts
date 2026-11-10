import { rmSync } from "node:fs";
import path from "node:path";
import {
  type BackupRunItem,
  type BackupStatusResponse,
  type BackupTrigger,
  backupRunItemSchema,
  toLocalDate,
} from "@bursar/shared";
import { desc, eq, max, ne } from "drizzle-orm";
import type { AuditLog } from "../audit";
import type { Config } from "../config";
import { deriveKey } from "../crypto";
import type { BursarDb, Sqlite } from "../db";
import { backupRuns } from "../db/schema";
import type { EventBus } from "../events/bus";
import { notificationKeys } from "../notifications/keys";
import type { NotificationService } from "../notifications/service";
import { BackupUploadError, createBackup, listBackupSets, reduceError } from "./backup";
import { LocalDirStore, type ObjectStore } from "./object-store";
import { pruneStore, retainedSetIds } from "./retention";

/** Spec §9: notify after this many consecutive failed runs. */
export const BACKUP_FAILURE_THRESHOLD = 2;
/** Hidden scratch directory inside `config.backup.dir` for the copy being made. */
export const BACKUP_WORK_DIR = ".work";
export const STALE_BACKUP_MESSAGE = "Interrupted by a restart";
export const BACKUP_STATUS_LIMIT = 10;

/** A second run was asked for while one is in progress in this process. */
export class BackupInProgressError extends Error {
  constructor() {
    super("A backup is already running");
    this.name = "BackupInProgressError";
  }
}

export interface BackupServiceDeps {
  sqlite: Sqlite;
  db: BursarDb;
  masterKey: Buffer;
  config: Config["backup"];
  /** The S3-compatible target, or null/absent for local copies only. */
  s3?: ObjectStore | null;
  notifications: NotificationService;
  bus: EventBus;
  audit: AuditLog;
  timezone: string;
  now?: () => number;
}

type BackupRunRow = typeof backupRuns.$inferSelect;

/**
 * Runs backups (one at a time per process) and records each run in `backup_runs`. A run always
 * writes the set to the local directory and, when configured, to S3; after a run where every
 * store took the set, the 7/4/6 retention is applied to every store. A failed run is recorded,
 * announced on the bus and, from the second consecutive failure, raises `backup_failing`.
 * `run` resolves with the recorded run in both cases: failures are data, not exceptions.
 */
export class BackupService {
  private readonly local: LocalDirStore;
  private readonly s3: ObjectStore | null;
  private readonly now: () => number;
  private running = false;

  constructor(private readonly deps: BackupServiceDeps) {
    this.local = new LocalDirStore(deps.config.dir);
    this.s3 = deps.s3 ?? null;
    this.now = deps.now ?? Date.now;
  }

  target(): "local" | "s3" {
    return this.s3 ? "s3" : "local";
  }

  /** True while `run` is in progress in this process. */
  isRunning(): boolean {
    return this.running;
  }

  async run(trigger: BackupTrigger): Promise<BackupRunItem> {
    if (this.running) throw new BackupInProgressError();
    this.running = true;
    try {
      return await this.execute(trigger);
    } finally {
      this.running = false;
    }
  }

  status(limit: number = BACKUP_STATUS_LIMIT): BackupStatusResponse {
    const rows = this.deps.db
      .select()
      .from(backupRuns)
      .orderBy(desc(backupRuns.startedAt), desc(backupRuns.id))
      .limit(Math.min(Math.max(Math.trunc(limit), 1), 100))
      .all();
    const last = this.deps.db
      .select({ at: max(backupRuns.finishedAt) })
      .from(backupRuns)
      .where(eq(backupRuns.status, "succeeded"))
      .get();
    return {
      target: this.target(),
      lastSuccessAt: last?.at ?? null,
      consecutiveFailures: this.consecutiveFailures(),
      runs: rows.map(toItem),
    };
  }

  /**
   * Boot only (single process): a run still marked `running` was cut off by the previous
   * process. Marks it failed and clears the work directory. Returns the number of runs changed.
   */
  failStaleRuns(): number {
    const result = this.deps.db
      .update(backupRuns)
      .set({ status: "failed", finishedAt: this.now(), errorMessage: STALE_BACKUP_MESSAGE })
      .where(eq(backupRuns.status, "running"))
      .run();
    rmSync(path.join(this.deps.config.dir, BACKUP_WORK_DIR), { recursive: true, force: true });
    return result.changes;
  }

  private async execute(trigger: BackupTrigger): Promise<BackupRunItem> {
    const target = this.target();
    const inserted = this.deps.db
      .insert(backupRuns)
      .values({ trigger, status: "running", target, startedAt: this.now() })
      .returning({ id: backupRuns.id })
      .get();
    const id = inserted.id;
    const stores = this.s3 ? [this.local, this.s3] : [this.local];
    let setId: string | null = null;
    let sizeBytes: number | null = null;
    try {
      const result = await createBackup({
        sqlite: this.deps.sqlite,
        dbPassphrase: deriveKey(this.deps.masterKey, "database").toString("hex"),
        workDir: path.join(this.deps.config.dir, BACKUP_WORK_DIR),
        stores,
        now: this.now,
      });
      setId = result.setId;
      sizeBytes = result.sizeBytes;
      for (const store of stores) {
        const keep = retainedSetIds(await listBackupSets(store), this.now(), this.deps.timezone);
        await pruneStore(store, keep);
      }
    } catch (error) {
      if (error instanceof BackupUploadError) {
        // A copy was made and the stores before the failing one hold it: record which set.
        setId = error.setId;
        sizeBytes = error.sizeBytes;
      }
      return this.finishFailed(id, trigger, setId, sizeBytes, error);
    }

    this.deps.db
      .update(backupRuns)
      .set({ status: "succeeded", setId, sizeBytes, finishedAt: this.now(), errorMessage: null })
      .where(eq(backupRuns.id, id))
      .run();
    this.deps.audit.record({
      actor: trigger === "scheduled" ? "system" : "user",
      action: "backup.run",
      target: setId ?? undefined,
      details: { status: "succeeded", trigger, target, sizeBytes },
    });
    this.deps.bus.publish({ type: "backup.finished", status: "succeeded" });
    return this.item(id);
  }

  private finishFailed(
    id: number,
    trigger: BackupTrigger,
    setId: string | null,
    sizeBytes: number | null,
    error: unknown,
  ): BackupRunItem {
    const target = this.target();
    this.deps.db
      .update(backupRuns)
      .set({
        status: "failed",
        setId,
        sizeBytes,
        finishedAt: this.now(),
        errorMessage: reduceError(error),
      })
      .where(eq(backupRuns.id, id))
      .run();
    this.deps.audit.record({
      actor: trigger === "scheduled" ? "system" : "user",
      action: "backup.run",
      target: setId ?? undefined,
      details: { status: "failed", trigger, target },
    });
    this.deps.bus.publish({ type: "backup.finished", status: "failed" });
    const failures = this.consecutiveFailures();
    if (failures >= BACKUP_FAILURE_THRESHOLD) {
      // Keyed by local date: at most one notification per day while backups keep failing.
      this.deps.notifications.raise({
        event: "backup_failing",
        dedupeKey: notificationKeys.backupFailing(toLocalDate(this.now(), this.deps.timezone)),
        params: { failures },
        link: "/settings#backups",
      });
    }
    return this.item(id);
  }

  /** Failed runs since the last successful one (running rows are skipped). */
  private consecutiveFailures(): number {
    const rows = this.deps.db
      .select({ status: backupRuns.status })
      .from(backupRuns)
      .where(ne(backupRuns.status, "running"))
      .orderBy(desc(backupRuns.startedAt), desc(backupRuns.id))
      .limit(100)
      .all();
    let failures = 0;
    for (const row of rows) {
      if (row.status !== "failed") break;
      failures += 1;
    }
    return failures;
  }

  private item(id: number): BackupRunItem {
    const row = this.deps.db.select().from(backupRuns).where(eq(backupRuns.id, id)).get();
    if (!row) throw new Error(`Backup run ${id} disappeared`);
    return toItem(row);
  }
}

function toItem(row: BackupRunRow): BackupRunItem {
  return backupRunItemSchema.parse({
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    target: row.target,
    setId: row.setId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    sizeBytes: row.sizeBytes,
    errorMessage: row.errorMessage,
  });
}
