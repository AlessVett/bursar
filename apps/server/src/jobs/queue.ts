import type { Sqlite } from "../db";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: number;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface JobState {
  status: JobStatus;
  attempts: number;
  runAfter: number;
  lastError: string | null;
}

interface ClaimedRow {
  id: number;
  type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  runAfter?: number;
  maxAttempts?: number;
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** (attempt - 1), 3_600_000);
}

const ACTIVE_STATUSES = "('queued', 'running')";

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

export class JobQueue {
  /**
   * `onCorruptPayload` is called for a claimed job whose stored payload is not valid JSON; the
   * queue has already failed that job permanently by then.
   */
  constructor(
    private readonly sqlite: Sqlite,
    private readonly now: () => number = Date.now,
    private readonly onCorruptPayload: (job: { id: number; type: string }) => void = () => {},
  ) {}

  enqueue(type: string, payload: unknown, options: EnqueueOptions = {}): number {
    return this.insert(type, null, payload, options);
  }

  /**
   * Enqueues unless a queued or running job already carries `dedupeKey`, in which case that job is
   * returned. A key is free again once its job has succeeded or failed.
   */
  enqueueUnique(
    type: string,
    dedupeKey: string,
    payload: unknown,
    options: EnqueueOptions = {},
  ): { id: number; created: boolean } {
    try {
      return this.sqlite
        .transaction((): { id: number; created: boolean } => {
          const existing = this.findActive(dedupeKey);
          if (existing) return { id: existing.id, created: false };
          return { id: this.insert(type, dedupeKey, payload, options), created: true };
        })
        .immediate();
    } catch (error) {
      // The partial unique index is the safety net for a writer that raced the select.
      if (isUniqueViolation(error)) {
        const existing = this.findActive(dedupeKey);
        if (existing) return { id: existing.id, created: false };
      }
      throw error;
    }
  }

  findActive(dedupeKey: string): { id: number; status: "queued" | "running" } | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, status FROM jobs
         WHERE dedupe_key = ? AND status IN ${ACTIVE_STATUSES}
         ORDER BY id LIMIT 1`,
      )
      .get(dedupeKey) as { id: number; status: "queued" | "running" } | undefined;
    return row ?? null;
  }

  /** Dedupe keys of every queued or running job whose key starts with `prefix`. */
  activeKeys(prefix: string): Set<string> {
    const rows = this.sqlite
      .prepare(
        `SELECT dedupe_key FROM jobs
         WHERE dedupe_key IS NOT NULL AND substr(dedupe_key, 1, ?) = ?
           AND status IN ${ACTIVE_STATUSES}`,
      )
      .all(prefix.length, prefix) as { dedupe_key: string }[];
    return new Set(rows.map((row) => row.dedupe_key));
  }

  /** Removes queued (not yet running) jobs with this key and returns how many were removed. */
  cancelQueued(dedupeKey: string): number {
    return this.sqlite
      .prepare("DELETE FROM jobs WHERE dedupe_key = ? AND status = 'queued'")
      .run(dedupeKey).changes;
  }

  /** Deletes succeeded and failed jobs last touched more than `olderThanMs` ago. */
  purgeFinished(olderThanMs: number): number {
    return this.sqlite
      .prepare("DELETE FROM jobs WHERE status IN ('succeeded', 'failed') AND updated_at < ?")
      .run(this.now() - olderThanMs).changes;
  }

  claimNext(): JobRecord | null {
    for (;;) {
      const ts = this.now();
      const row = this.sqlite
        .prepare(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ?
           WHERE id = (
             SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ?
             ORDER BY run_after, id LIMIT 1
           )
           RETURNING id, type, payload, attempts, max_attempts`,
        )
        .get(ts, ts, ts) as ClaimedRow | undefined;
      if (!row) return null;
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        // Never strand the job as running: fail it for good and look at the next one.
        this.fail(row.id, "Job payload is not valid JSON", true, row.attempts);
        this.onCorruptPayload({ id: row.id, type: row.type });
        continue;
      }
      return {
        id: row.id,
        type: row.type,
        payload,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
      };
    }
  }

  /**
   * Marks a running job succeeded. Does nothing when the job is no longer running (for example
   * after `recoverStale` requeued it) or, when `attempt` is given, when it has been claimed again
   * since: a slow handler must not complete somebody else's run.
   */
  complete(id: number, attempt?: number): void {
    this.sqlite
      .prepare(
        `UPDATE jobs SET status = 'succeeded', locked_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'running' AND (? IS NULL OR attempts = ?)`,
      )
      .run(this.now(), id, attempt ?? null, attempt ?? null);
  }

  /**
   * Records a failure of a running job in one transaction: requeued with backoff while attempts
   * remain, failed otherwise or when `permanent`. Returns "ignored" (and changes nothing) when the
   * job is not running, or when `attempt` is given and no longer matches.
   */
  fail(
    id: number,
    error: string,
    permanent = false,
    attempt?: number,
  ): "retry" | "failed" | "ignored" {
    return this.sqlite
      .transaction((): "retry" | "failed" | "ignored" => {
        const row = this.sqlite
          .prepare(
            `SELECT attempts, max_attempts FROM jobs
             WHERE id = ? AND status = 'running' AND (? IS NULL OR attempts = ?)`,
          )
          .get(id, attempt ?? null, attempt ?? null) as
          | { attempts: number; max_attempts: number }
          | undefined;
        if (!row) return "ignored";
        const ts = this.now();
        if (!permanent && row.attempts < row.max_attempts) {
          this.sqlite
            .prepare(
              `UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = ?, run_after = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(error, ts + backoffMs(row.attempts), ts, id);
          return "retry";
        }
        this.sqlite
          .prepare(
            `UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(error, ts, id);
        return "failed";
      })
      .immediate();
  }

  /**
   * Requeues (or fails, once attempts are exhausted) running jobs locked `olderThanMs` ago or more.
   * `recoverStale(0)` recovers every running job: at boot nothing can still be running.
   */
  recoverStale(olderThanMs: number): number {
    const ts = this.now();
    const cutoff = ts - olderThanMs;
    return this.sqlite.transaction(() => {
      const exhausted = this.sqlite
        .prepare(
          `UPDATE jobs SET status = 'failed', locked_at = NULL, updated_at = ?,
             last_error = 'Interrupted while running; attempts exhausted'
           WHERE status = 'running' AND locked_at <= ? AND attempts >= max_attempts`,
        )
        .run(ts, cutoff);
      const requeued = this.sqlite
        .prepare(
          `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = ?
           WHERE status = 'running' AND locked_at <= ? AND attempts < max_attempts`,
        )
        .run(ts, cutoff);
      return exhausted.changes + requeued.changes;
    })();
  }

  get(id: number): JobState | null {
    const row = this.sqlite
      .prepare("SELECT status, attempts, run_after, last_error FROM jobs WHERE id = ?")
      .get(id) as
      | { status: JobStatus; attempts: number; run_after: number; last_error: string | null }
      | undefined;
    if (!row) return null;
    return {
      status: row.status,
      attempts: row.attempts,
      runAfter: row.run_after,
      lastError: row.last_error,
    };
  }

  private insert(
    type: string,
    dedupeKey: string | null,
    payload: unknown,
    options: EnqueueOptions,
  ): number {
    const ts = this.now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_after, dedupe_key, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        type,
        JSON.stringify(payload ?? null),
        options.maxAttempts ?? 3,
        options.runAfter ?? ts,
        dedupeKey,
        ts,
        ts,
      );
    return Number(result.lastInsertRowid);
  }
}
