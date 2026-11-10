import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { JobQueue } from "./queue";
import { type JobHandler, JobWorker, PermanentJobError } from "./worker";

const logger = pino({ level: "silent" });

describe("JobWorker", () => {
  let t: TestDatabase;
  let queue: JobQueue;
  let started: JobWorker[];

  /** Starts a polling worker that afterEach stops, even when the test fails. */
  const startWorker = (handlers: ReadonlyMap<string, JobHandler>): JobWorker => {
    const worker = new JobWorker(queue, handlers, logger, 10);
    started.push(worker);
    worker.start();
    return worker;
  };

  beforeEach(() => {
    t = createTestDatabase();
    queue = new JobQueue(t.sqlite);
    started = [];
  });
  afterEach(async () => {
    // Stop polling before the database goes away.
    for (const worker of started) await worker.stop();
    t.dispose();
  });

  it("runs the handler and completes the job", async () => {
    const seen: unknown[] = [];
    const handlers = new Map<string, JobHandler>([
      [
        "echo",
        async (job) => {
          seen.push(job.payload);
        },
      ],
    ]);
    const worker = new JobWorker(queue, handlers, logger);
    const id = queue.enqueue("echo", { hello: "world" });
    expect(await worker.runOnce()).toBe(true);
    expect(seen).toEqual([{ hello: "world" }]);
    expect(queue.get(id)?.status).toBe("succeeded");
    expect(await worker.runOnce()).toBe(false);
  });

  it("records handler errors for a retry", async () => {
    const handlers = new Map<string, JobHandler>([
      [
        "boom",
        async () => {
          throw new Error("exploded");
        },
      ],
    ]);
    const worker = new JobWorker(queue, handlers, logger);
    const id = queue.enqueue("boom", null);
    await worker.runOnce();
    expect(queue.get(id)).toMatchObject({ status: "queued", lastError: "exploded" });
  });

  it("fails jobs without a handler permanently", async () => {
    const worker = new JobWorker(queue, new Map(), logger);
    const id = queue.enqueue("unknown", null);
    await worker.runOnce();
    expect(queue.get(id)).toMatchObject({ status: "failed" });
    expect(queue.get(id)?.lastError).toContain("unknown");
  });

  it("fails a job for good when the handler throws PermanentJobError", async () => {
    const handlers = new Map<string, JobHandler>([
      [
        "bad",
        async () => {
          throw new PermanentJobError("payload is wrong");
        },
      ],
    ]);
    const worker = new JobWorker(queue, handlers, logger);
    const id = queue.enqueue("bad", null);
    await worker.runOnce();
    expect(queue.get(id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "payload is wrong",
    });
    expect(await worker.runOnce()).toBe(false);
  });

  it("keeps retrying ordinary errors until the attempts run out", async () => {
    let now = 1_000_000;
    const clocked = new JobQueue(t.sqlite, () => now);
    const handlers = new Map<string, JobHandler>([
      [
        "flaky",
        async () => {
          throw new Error("temporary");
        },
      ],
    ]);
    const worker = new JobWorker(clocked, handlers, logger);
    const id = clocked.enqueue("flaky", null, { maxAttempts: 2 });
    await worker.runOnce();
    expect(clocked.get(id)?.status).toBe("queued");
    now += 3_600_000;
    await worker.runOnce();
    expect(clocked.get(id)).toMatchObject({
      status: "failed",
      attempts: 2,
      lastError: "temporary",
    });
  });

  it("does not let a recovered job be completed or failed by its old handler", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlers = new Map<string, JobHandler>([["slow", () => gate]]);
    const worker = new JobWorker(queue, handlers, logger);
    const id = queue.enqueue("slow", null);
    const running = worker.runOnce();
    await vi.waitFor(() => expect(queue.get(id)?.status).toBe("running"));
    expect(queue.recoverStale(0)).toBe(1);
    expect(queue.claimNext()).toMatchObject({ id, attempts: 2 });
    release();
    await running;
    // The first run finished, but the job now belongs to the second claim.
    expect(queue.get(id)).toMatchObject({ status: "running", attempts: 2 });
  });

  it("logs the stack of a failing handler and flags the final failure as an error", async () => {
    const lines: Record<string, unknown>[] = [];
    const capturing = pino(
      { level: "info" },
      new Writable({
        write(chunk, _encoding, callback) {
          lines.push(JSON.parse(chunk.toString()));
          callback();
        },
      }),
    );
    const handlers = new Map<string, JobHandler>([
      [
        "boom",
        async () => {
          throw new Error("exploded");
        },
      ],
    ]);
    const worker = new JobWorker(queue, handlers, capturing);
    queue.enqueue("boom", null, { maxAttempts: 1 });
    await worker.runOnce();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 50,
      msg: "Job failed for good",
      type: "boom",
      attempt: 1,
      outcome: "failed",
      permanent: false,
      error: "exploded",
    });
    expect(String(lines[0]?.stack)).toContain("worker.test.ts");
  });

  it("logs a retry as a warning", async () => {
    const lines: Record<string, unknown>[] = [];
    const capturing = pino(
      { level: "info" },
      new Writable({
        write(chunk, _encoding, callback) {
          lines.push(JSON.parse(chunk.toString()));
          callback();
        },
      }),
    );
    const handlers = new Map<string, JobHandler>([
      [
        "boom",
        async () => {
          throw new Error("exploded");
        },
      ],
    ]);
    const worker = new JobWorker(queue, handlers, capturing);
    queue.enqueue("boom", null);
    await worker.runOnce();
    expect(lines[0]).toMatchObject({ level: 40, msg: "Job failed", outcome: "retry" });
  });

  it("drains the queue after start and stops cleanly", async () => {
    let count = 0;
    const handlers = new Map<string, JobHandler>([
      [
        "count",
        async () => {
          count += 1;
        },
      ],
    ]);
    queue.enqueue("count", null);
    queue.enqueue("count", null);
    const worker = startWorker(handlers);
    await vi.waitFor(() => expect(count).toBe(2));
    await worker.stop();
  });

  it("survives queue errors during drain without an unhandled rejection", async () => {
    const claim = vi.spyOn(queue, "claimNext").mockImplementationOnce(() => {
      throw new Error("db locked");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const id = queue.enqueue("ok", null);
      const worker = startWorker(new Map([["ok", async () => {}]]));
      await vi.waitFor(() => expect(queue.get(id)?.status).toBe("succeeded"));
      expect(claim).toHaveBeenCalled();
      await expect(worker.stop()).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });
});
