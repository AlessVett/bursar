import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_IDLE_MS, SessionStore } from "./auth/sessions";
import { JobQueue } from "./jobs/queue";
import { maintenanceTask } from "./maintenance";
import { createTestDatabase, type TestDatabase } from "./test/db";

describe("maintenanceTask", () => {
  let t: TestDatabase;
  afterEach(() => t.dispose());
  beforeEach(() => {
    t = createTestDatabase();
  });

  it("requeues stale jobs and purges expired sessions", async () => {
    let now = Date.UTC(2026, 10, 9);
    const queue = new JobQueue(t.sqlite, () => now);
    const sessions = new SessionStore(t.db, () => now);
    const id = queue.enqueue("x", null);
    queue.claimNext();
    const token = sessions.create(null);
    now += SESSION_IDLE_MS + 1;
    await maintenanceTask(queue, sessions, pino({ level: "silent" })).run(new Date(now));
    expect(queue.get(id)?.status).toBe("queued");
    expect(sessions.validate(token)).toBeNull();
    expect(sessions.purgeExpired()).toBe(0);
  });
});
