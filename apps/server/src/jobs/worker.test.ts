import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { JobQueue } from "./queue";
import { type JobHandler, JobWorker } from "./worker";

const logger = pino({ level: "silent" });

describe("JobWorker", () => {
  let t: TestDatabase;
  let queue: JobQueue;

  beforeEach(() => {
    t = createTestDatabase();
    queue = new JobQueue(t.sqlite);
  });
  afterEach(() => t.dispose());

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
    const worker = new JobWorker(queue, handlers, logger, 10);
    queue.enqueue("count", null);
    queue.enqueue("count", null);
    worker.start();
    await vi.waitFor(() => expect(count).toBe(2));
    await worker.stop();
  });

  it("survives queue errors during drain without an unhandled rejection", async () => {
    const claim = vi.spyOn(queue, "claimNext").mockImplementationOnce(() => {
      throw new Error("db locked");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const worker = new JobWorker(queue, new Map([["ok", async () => {}]]), logger, 10);
    const id = queue.enqueue("ok", null);
    worker.start();
    await vi.waitFor(() => expect(queue.get(id)?.status).toBe("succeeded"));
    expect(claim).toHaveBeenCalled();
    await expect(worker.stop()).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
