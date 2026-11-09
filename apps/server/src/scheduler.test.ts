import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "./scheduler";

const logger = pino({ level: "silent" });

describe("Scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks immediately on start and then every interval until stopped", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const scheduler = new Scheduler(
      [
        {
          name: "count",
          run: () => {
            runs += 1;
          },
        },
      ],
      logger,
      60_000,
    );
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(2);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(2);
  });

  it("keeps running the other tasks when one throws", async () => {
    let ran = false;
    const scheduler = new Scheduler(
      [
        {
          name: "broken",
          run: () => {
            throw new Error("nope");
          },
        },
        {
          name: "healthy",
          run: () => {
            ran = true;
          },
        },
      ],
      logger,
    );
    await scheduler.tick();
    expect(ran).toBe(true);
  });

  it("skips a tick while the previous one is still running", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const scheduler = new Scheduler(
      [
        {
          name: "slow",
          run: () => {
            calls += 1;
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        },
      ],
      logger,
    );
    const first = scheduler.tick();
    await scheduler.tick();
    expect(calls).toBe(1);
    release();
    await first;
  });
});
