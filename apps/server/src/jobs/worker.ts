import type { Logger } from "pino";
import type { JobQueue, JobRecord } from "./queue";

export type JobHandler = (job: JobRecord) => Promise<void>;

/**
 * Thrown by a handler (or by `parsePayload`) when retrying cannot help: the job is failed at once
 * and its message becomes the job's `last_error`, so keep it free of secrets and personal data.
 */
export class PermanentJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly logger: Logger,
    private readonly pollMs = 1_000,
  ) {}

  async runOnce(): Promise<boolean> {
    const job = this.queue.claimNext();
    if (!job) return false;
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.queue.fail(
        job.id,
        `No handler registered for job type "${job.type}"`,
        true,
        job.attempts,
      );
      this.logger.error({ jobId: job.id, type: job.type }, "Job has no handler");
      return true;
    }
    try {
      await handler(job);
      this.queue.complete(job.id, job.attempts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof PermanentJobError;
      const outcome = this.queue.fail(job.id, message, permanent, job.attempts);
      const fields = {
        jobId: job.id,
        type: job.type,
        attempt: job.attempts,
        outcome,
        permanent,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      };
      if (outcome === "failed") this.logger.error(fields, "Job failed for good");
      else this.logger.warn(fields, "Job failed");
    }
    return true;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.draining;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.draining = this.drain().finally(() => {
        this.draining = null;
        if (!this.stopped) this.schedule(this.pollMs);
      });
    }, delayMs);
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const ran = await this.runOnce();
        if (!ran) break;
      }
    } catch (error) {
      // Queue/database errors outside the handler: log and retry on the next poll.
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Job worker drain failed",
      );
    }
  }
}
