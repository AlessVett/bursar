import type { Logger } from "pino";

export interface ScheduledTask {
  name: string;
  run(now: Date): Promise<void> | void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly tasks: readonly ScheduledTask[],
    private readonly logger: Logger,
    private readonly intervalMs = 60_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = this.runAll();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  private async runAll(): Promise<void> {
    for (const task of this.tasks) {
      try {
        await task.run(this.now());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ task: task.name, error: message }, "Scheduled task failed");
      }
    }
  }
}
