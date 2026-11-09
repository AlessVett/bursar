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

export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** (attempt - 1), 3_600_000);
}

export class JobQueue {
  constructor(
    private readonly sqlite: Sqlite,
    private readonly now: () => number = Date.now,
  ) {}

  enqueue(
    type: string,
    payload: unknown,
    options: { runAfter?: number; maxAttempts?: number } = {},
  ): number {
    const ts = this.now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)`,
      )
      .run(
        type,
        JSON.stringify(payload ?? null),
        options.maxAttempts ?? 3,
        options.runAfter ?? ts,
        ts,
        ts,
      );
    return Number(result.lastInsertRowid);
  }

  claimNext(): JobRecord | null {
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
    return {
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload),
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
  }

  complete(id: number): void {
    this.sqlite
      .prepare(
        `UPDATE jobs SET status = 'succeeded', locked_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), id);
  }

  fail(id: number, error: string, permanent = false): "retry" | "failed" {
    const row = this.sqlite
      .prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?")
      .get(id) as { attempts: number; max_attempts: number } | undefined;
    if (!row) throw new Error(`Job ${id} not found`);
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
  }

  recoverStale(olderThanMs: number): number {
    const ts = this.now();
    const cutoff = ts - olderThanMs;
    return this.sqlite.transaction(() => {
      const exhausted = this.sqlite
        .prepare(
          `UPDATE jobs SET status = 'failed', locked_at = NULL, updated_at = ?,
             last_error = 'Interrupted while running; attempts exhausted'
           WHERE status = 'running' AND locked_at < ? AND attempts >= max_attempts`,
        )
        .run(ts, cutoff);
      const requeued = this.sqlite
        .prepare(
          `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = ?
           WHERE status = 'running' AND locked_at < ? AND attempts < max_attempts`,
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
}
