interface Window {
  count: number;
  startedAt: number;
}

export class FailureLimiter {
  private readonly failures = new Map<string, Window>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.current(key);
    return entry !== undefined && entry.count >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const entry = this.current(key);
    if (entry) entry.count += 1;
    else this.failures.set(key, { count: 1, startedAt: this.now() });
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private current(key: string): Window | undefined {
    const entry = this.failures.get(key);
    if (entry && this.now() - entry.startedAt >= this.windowMs) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }
}
