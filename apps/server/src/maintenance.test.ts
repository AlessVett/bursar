import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FailureLimiter } from "./auth/rate-limit";
import { SESSION_IDLE_MS, SessionStore } from "./auth/sessions";
import { JobQueue } from "./jobs/queue";
import { maintenanceTask } from "./maintenance";
import { createTestDatabase, type TestDatabase } from "./test/db";

const silent = pino({ level: "silent" });

describe("maintenanceTask", () => {
  let t: TestDatabase;
  let now: number;
  let queue: JobQueue;
  let sessions: SessionStore;

  beforeEach(() => {
    t = createTestDatabase();
    now = Date.UTC(2026, 10, 9);
    queue = new JobQueue(t.sqlite, () => now);
    sessions = new SessionStore(t.db, () => now);
  });
  afterEach(() => t.dispose());

  function capture() {
    const lines: Record<string, unknown>[] = [];
    const logger = pino(
      { level: "info" },
      new Writable({
        write(chunk, _encoding, callback) {
          lines.push(JSON.parse(chunk.toString()));
          callback();
        },
      }),
    );
    return { lines, logger };
  }

  it("leaves a long-running job alone and purges expired sessions", async () => {
    const id = queue.enqueue("x", null);
    queue.claimNext();
    const token = sessions.create(null);
    now += SESSION_IDLE_MS + 1;
    await maintenanceTask({ queue, sessions, limiters: [], logger: silent }).run(new Date(now));
    // The worker of this process may still be running it: it is neither requeued nor failed, and
    // its handler completes it exactly once.
    expect(queue.get(id)?.status).toBe("running");
    queue.complete(id);
    expect(queue.get(id)?.status).toBe("succeeded");
    expect(sessions.validate(token)).toBeNull();
    expect(sessions.purgeExpired()).toBe(0);
  });

  it("sweeps every limiter and purges finished jobs older than 30 days", async () => {
    const day = 24 * 60 * 60_000;
    const first = new FailureLimiter(1, 1_000, () => now);
    const second = new FailureLimiter(1, 1_000, () => now);
    first.recordFailure("a");
    second.recordFailure("b");
    second.recordFailure("c");
    const done = queue.enqueue("x", null);
    queue.claimNext();
    queue.complete(done);
    const recent = queue.enqueue("y", null);
    queue.claimNext();
    now += 31 * day;
    queue.complete(recent);
    const { lines, logger } = capture();
    await maintenanceTask({ queue, sessions, limiters: [first, second], logger }).run(
      new Date(now),
    );
    expect(queue.get(done)).toBeNull();
    expect(queue.get(recent)?.status).toBe("succeeded");
    expect(first.sweep() + second.sweep()).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: "Maintenance done",
      limiterEntriesSwept: 3,
      finishedJobsPurged: 1,
    });
  });

  it("runs each cleanup, logs its count and survives a cleanup that throws", async () => {
    const { lines, logger } = capture();
    const ran: string[] = [];
    await maintenanceTask({
      queue,
      sessions,
      limiters: [],
      logger,
      cleanups: [
        {
          name: "brokenCleanup",
          run: () => {
            ran.push("brokenCleanup");
            throw new Error("disk full");
          },
        },
        {
          name: "expiredAuthRequests",
          run: () => {
            ran.push("expiredAuthRequests");
            return 4;
          },
        },
      ],
    }).run(new Date(now));
    expect(ran).toEqual(["brokenCleanup", "expiredAuthRequests"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      msg: "Maintenance cleanup failed",
      cleanup: "brokenCleanup",
      error: "disk full",
    });
    expect(lines[1]).toMatchObject({ msg: "Maintenance done", expiredAuthRequests: 4 });
  });

  it("logs nothing when there was nothing to do", async () => {
    const { lines, logger } = capture();
    await maintenanceTask({
      queue,
      sessions,
      limiters: [new FailureLimiter()],
      logger,
      cleanups: [{ name: "noop", run: () => 0 }],
    }).run(new Date(now));
    expect(lines).toEqual([]);
  });

  it("is named maintenance", () => {
    expect(maintenanceTask({ queue, sessions, limiters: [], logger: silent }).name).toBe(
      "maintenance",
    );
  });
});
