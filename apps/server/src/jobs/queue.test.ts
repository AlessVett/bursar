import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("fails stale jobs that have used all their attempts instead of requeueing", () => {
    const id = queue.enqueue("a", null, { maxAttempts: 1 });
    queue.claimNext();
    now += 11 * 60_000;
    expect(queue.recoverStale(10 * 60_000)).toBe(1);
    expect(queue.get(id)).toMatchObject({ status: "failed" });
    expect(queue.get(id)?.lastError).toContain("attempts exhausted");
    expect(queue.claimNext()).toBeNull();
  });
  it("recoverStale(0) recovers a job claimed at the same instant", () => {
    const id = queue.enqueue("a", null);
    queue.claimNext();
    expect(queue.recoverStale(0)).toBe(1);
    expect(queue.get(id)?.status).toBe("queued");
  });

  describe("enqueueUnique", () => {
    it("returns the active job instead of creating a second one", () => {
      const first = queue.enqueueUnique("sync", "sync:1", { accountId: 1 });
      expect(first.created).toBe(true);
      expect(queue.enqueueUnique("sync", "sync:1", { accountId: 1 })).toEqual({
        id: first.id,
        created: false,
      });
      expect(queue.enqueueUnique("sync", "sync:2", { accountId: 2 }).created).toBe(true);
    });

    it("dedupes while the job is running", () => {
      const first = queue.enqueueUnique("sync", "sync:1", {});
      expect(queue.claimNext()?.id).toBe(first.id);
      expect(queue.enqueueUnique("sync", "sync:1", {})).toEqual({ id: first.id, created: false });
    });

    it("allows a new job once the previous one succeeded or failed", () => {
      const first = queue.enqueueUnique("sync", "sync:1", {});
      queue.claimNext();
      queue.complete(first.id);
      const second = queue.enqueueUnique("sync", "sync:1", {});
      expect(second.created).toBe(true);
      expect(second.id).not.toBe(first.id);
      queue.claimNext();
      queue.fail(second.id, "boom", true);
      expect(queue.enqueueUnique("sync", "sync:1", {}).created).toBe(true);
    });

    it("keeps the key while a failed job waits for its retry", () => {
      const first = queue.enqueueUnique("sync", "sync:1", {});
      queue.claimNext();
      expect(queue.fail(first.id, "boom")).toBe("retry");
      expect(queue.enqueueUnique("sync", "sync:1", {}).created).toBe(false);
    });

    it("stores the payload and honours runAfter and maxAttempts", () => {
      const { id } = queue.enqueueUnique(
        "sync",
        "sync:1",
        { accountId: 1 },
        {
          runAfter: now + 5_000,
          maxAttempts: 1,
        },
      );
      expect(queue.claimNext()).toBeNull();
      now += 5_000;
      expect(queue.claimNext()).toMatchObject({
        id,
        payload: { accountId: 1 },
        maxAttempts: 1,
      });
    });

    it("maps a unique-index violation raised by a racing writer to the existing job", () => {
      // The select misses a row that another writer committed first: the insert must hit the
      // partial unique index and the call must still return that row.
      const winner = queue.enqueueUnique("sync", "sync:9", {});
      const spy = vi.spyOn(queue, "findActive").mockImplementationOnce(() => null);
      expect(queue.enqueueUnique("sync", "sync:9", {})).toEqual({ id: winner.id, created: false });
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it("works inside an outer transaction", () => {
      const results = t.sqlite.transaction(() => [
        queue.enqueueUnique("sync", "sync:1", {}),
        queue.enqueueUnique("sync", "sync:1", {}),
      ])();
      expect(results.map((r) => r.created)).toEqual([true, false]);
    });

    it("does not dedupe plain enqueue calls", () => {
      expect(queue.enqueue("a", null)).not.toBe(queue.enqueue("a", null));
    });
  });

  describe("findActive, activeKeys and cancelQueued", () => {
    it("finds queued and running jobs only", () => {
      const { id } = queue.enqueueUnique("sync", "sync:1", {});
      expect(queue.findActive("sync:1")).toEqual({ id, status: "queued" });
      queue.claimNext();
      expect(queue.findActive("sync:1")).toEqual({ id, status: "running" });
      queue.complete(id);
      expect(queue.findActive("sync:1")).toBeNull();
      expect(queue.findActive("sync:404")).toBeNull();
    });

    it("lists the active keys that start with a prefix, treating it literally", () => {
      queue.enqueueUnique("sync", "sync:1", {});
      queue.enqueueUnique("sync", "sync:2", {});
      queue.enqueueUnique("email", "email:1", {});
      queue.enqueueUnique("sync", "sync_3", {});
      queue.enqueue("plain", null);
      expect(queue.activeKeys("sync:")).toEqual(new Set(["sync:1", "sync:2"]));
      expect(queue.activeKeys("s%")).toEqual(new Set());
      expect(queue.activeKeys("sync_")).toEqual(new Set(["sync_3"]));
      expect(queue.activeKeys("nothing:")).toEqual(new Set());
      queue.claimNext();
      expect(queue.activeKeys("sync:")).toEqual(new Set(["sync:1", "sync:2"]));
    });

    it("leaves finished jobs out of the active keys", () => {
      const { id } = queue.enqueueUnique("sync", "sync:1", {});
      queue.claimNext();
      queue.complete(id);
      expect(queue.activeKeys("sync:")).toEqual(new Set());
    });

    it("cancels queued jobs but never a running one", () => {
      queue.enqueueUnique("sync", "sync:1", {});
      expect(queue.cancelQueued("sync:1")).toBe(1);
      expect(queue.claimNext()).toBeNull();
      expect(queue.cancelQueued("sync:1")).toBe(0);

      const running = queue.enqueueUnique("sync", "sync:2", {});
      queue.claimNext();
      expect(queue.cancelQueued("sync:2")).toBe(0);
      expect(queue.get(running.id)?.status).toBe("running");
    });
  });

  describe("running guard", () => {
    it("ignores complete and fail for a job that is not running", () => {
      const id = queue.enqueue("a", null);
      queue.complete(id);
      expect(queue.get(id)?.status).toBe("queued");
      expect(queue.fail(id, "late")).toBe("ignored");
      expect(queue.get(id)).toMatchObject({ status: "queued", lastError: null, attempts: 0 });
      expect(queue.fail(9_999, "no such job")).toBe("ignored");
    });

    it("ignores a late result for a job that was recovered", () => {
      const id = queue.enqueue("a", null);
      queue.claimNext();
      queue.recoverStale(0);
      queue.complete(id, 1);
      expect(queue.fail(id, "late", false, 1)).toBe("ignored");
      expect(queue.get(id)).toMatchObject({ status: "queued", lastError: null });
    });

    it("ignores the result of an earlier attempt for a job that was reclaimed", () => {
      const id = queue.enqueue("a", null);
      queue.claimNext();
      queue.recoverStale(0);
      expect(queue.claimNext()).toMatchObject({ id, attempts: 2 });
      queue.complete(id, 1);
      expect(queue.fail(id, "stale handler", true, 1)).toBe("ignored");
      expect(queue.get(id)?.status).toBe("running");
      queue.complete(id, 2);
      expect(queue.get(id)?.status).toBe("succeeded");
    });

    it("does not resurrect a finished job", () => {
      const id = queue.enqueue("a", null);
      queue.claimNext();
      queue.complete(id);
      expect(queue.fail(id, "late")).toBe("ignored");
      expect(queue.get(id)).toMatchObject({ status: "succeeded", lastError: null });
    });

    it("rolls the whole failure back when the update throws", () => {
      const id = queue.enqueue("a", null);
      queue.claimNext();
      t.sqlite.exec(
        "CREATE TRIGGER block_fail BEFORE UPDATE ON jobs WHEN NEW.last_error = 'boom' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
      );
      expect(() => queue.fail(id, "boom")).toThrow("blocked");
      expect(t.sqlite.inTransaction).toBe(false);
      expect(queue.get(id)?.status).toBe("running");
    });
  });

  describe("corrupt payloads", () => {
    const insertCorrupt = (payload: string): number =>
      Number(
        t.sqlite
          .prepare(
            `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
             VALUES ('broken', ?, 'queued', 0, 3, ?, ?, ?)`,
          )
          .run(payload, now - 10, now, now).lastInsertRowid,
      );

    it("fails a job whose payload is not JSON and still claims the next one", () => {
      const corrupt = insertCorrupt("{not json");
      const good = queue.enqueue("ok", { fine: true });
      expect(queue.claimNext()).toMatchObject({ id: good, payload: { fine: true } });
      expect(queue.get(corrupt)).toMatchObject({ status: "failed" });
      expect(queue.get(corrupt)?.lastError).toContain("not valid JSON");
    });

    it("never leaves a corrupt job running", () => {
      const corrupt = insertCorrupt("");
      expect(queue.claimNext()).toBeNull();
      expect(queue.get(corrupt)?.status).toBe("failed");
      expect(queue.recoverStale(0)).toBe(0);
    });

    it("reports the corrupt job to the callback", () => {
      const seen: { id: number; type: string }[] = [];
      const reporting = new JobQueue(
        t.sqlite,
        () => now,
        (job) => seen.push(job),
      );
      const corrupt = insertCorrupt("nope");
      expect(reporting.claimNext()).toBeNull();
      expect(seen).toEqual([{ id: corrupt, type: "broken" }]);
    });
  });

  describe("purgeFinished", () => {
    it("deletes succeeded and failed jobs older than the threshold only", () => {
      const day = 24 * 60 * 60_000;
      const oldDone = queue.enqueue("a", null);
      queue.claimNext();
      queue.complete(oldDone);
      const oldFailed = queue.enqueue("b", null, { maxAttempts: 1 });
      queue.claimNext();
      queue.fail(oldFailed, "boom");
      const oldRunning = queue.enqueue("c", null);
      queue.claimNext();
      const oldQueued = queue.enqueue("d", null, { runAfter: now + 90 * day });
      now += 40 * day;
      const recentDone = queue.enqueue("e", null);
      queue.claimNext();
      queue.complete(recentDone);

      expect(queue.purgeFinished(30 * day)).toBe(2);
      expect(queue.get(oldDone)).toBeNull();
      expect(queue.get(oldFailed)).toBeNull();
      expect(queue.get(recentDone)?.status).toBe("succeeded");
      expect(queue.get(oldRunning)?.status).toBe("running");
      expect(queue.get(oldQueued)?.status).toBe("queued");
      expect(queue.purgeFinished(30 * day)).toBe(0);
    });
  });
});

describe("backoffMs", () => {
  it("grows four times per attempt and caps at one hour", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(10)).toBe(3_600_000);
  });
});
