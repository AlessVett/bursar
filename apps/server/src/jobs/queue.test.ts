import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { backoffMs, JobQueue } from "./queue";

describe("JobQueue", () => {
  let t: TestDatabase;
  let now: number;
  let queue: JobQueue;

  beforeEach(() => {
    t = createTestDatabase();
    now = 1_000_000;
    queue = new JobQueue(t.sqlite, () => now);
  });
  afterEach(() => t.dispose());

  it("claims due jobs in order and leaves future ones queued", () => {
    const later = queue.enqueue("b", {}, { runAfter: now + 60_000 });
    const first = queue.enqueue("a", { n: 1 });
    expect(queue.claimNext()).toMatchObject({
      id: first,
      type: "a",
      payload: { n: 1 },
      attempts: 1,
    });
    expect(queue.claimNext()).toBeNull();
    now += 60_000;
    expect(queue.claimNext()?.id).toBe(later);
  });

  it("retries with backoff, then fails after the last attempt", () => {
    const id = queue.enqueue("a", null, { maxAttempts: 2 });
    queue.claimNext();
    expect(queue.fail(id, "boom")).toBe("retry");
    expect(queue.get(id)).toMatchObject({
      status: "queued",
      lastError: "boom",
      runAfter: now + backoffMs(1),
    });
    now += backoffMs(1);
    queue.claimNext();
    expect(queue.fail(id, "boom again")).toBe("failed");
    expect(queue.get(id)?.status).toBe("failed");
  });

  it("fails permanently when asked to", () => {
    const id = queue.enqueue("a", null);
    queue.claimNext();
    expect(queue.fail(id, "no handler", true)).toBe("failed");
  });

  it("marks completed jobs as succeeded", () => {
    const id = queue.enqueue("a", null);
    queue.claimNext();
    queue.complete(id);
    expect(queue.get(id)).toMatchObject({ status: "succeeded", lastError: null });
  });

  it("requeues jobs whose lock is stale", () => {
    const id = queue.enqueue("a", null);
    queue.claimNext();
    now += 11 * 60_000;
    expect(queue.recoverStale(10 * 60_000)).toBe(1);
    expect(queue.get(id)?.status).toBe("queued");
  });
});

describe("backoffMs", () => {
  it("grows four times per attempt and caps at one hour", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(10)).toBe(3_600_000);
  });
});
