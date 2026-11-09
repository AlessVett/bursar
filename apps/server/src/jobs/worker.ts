import type { Logger } from "pino";
import type { JobQueue, JobRecord } from "./queue";

export type JobHandler = (job: JobRecord) => Promise<void>;

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
      this.queue.fail(job.id, `No handler registered for job type "${job.type}"`, true);
      this.logger.error({ jobId: job.id, type: job.type }, "Job has no handler");
      return true;
    }
    try {
      await handler(job);
      this.queue.complete(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = this.queue.fail(job.id, message);
      this.logger.warn({ jobId: job.id, type: job.type, outcome, error: message }, "Job failed");
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
    while (!this.stopped) {
      const ran = await this.runOnce();
      if (!ran) break;
    }
  }
}
