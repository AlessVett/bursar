import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "../auth/routes";
import { SessionStore } from "../auth/sessions";
import { loadConfig } from "../config";
import type { Sqlite } from "../db";
import { JobQueue } from "../jobs/queue";
import { SYNC_ACCOUNT_JOB } from "../jobs/types";
import { type RunningBursar, startBursar } from "../server";
import { MIGRATIONS_DIR } from "../test/db";
import { insertAccount, insertConnection } from "../test/sync-fixture";

describe("sync wiring in startBursar", () => {
  let dir: string;
  let running: RunningBursar[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-sync-"));
    running = [];
  });
  afterEach(async () => {
    for (const instance of running) await instance.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(overrides: Parameters<typeof startBursar>[2]): Promise<RunningBursar> {
    const config = loadConfig({
      BURSAR_PUBLIC_URL: "http://127.0.0.1",
      TZ: "UTC",
      BURSAR_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
      BURSAR_DATA_DIR: dir,
      BURSAR_MIGRATIONS_DIR: MIGRATIONS_DIR,
    });
    const instance = await startBursar(
      { ...config, port: 0 },
      pino({ level: "silent" }),
      overrides,
    );
    running.push(instance);
    return instance;
  }

  it("mounts the manual sync route behind the session check", async () => {
    const seeded = { token: "", accountId: 0 };
    const instance = await boot({
      bankingClient: null,
      mailer: null,
      seed: ({ db, sqlite, now }) => {
        const connectionId = insertConnection(sqlite, { now: now() });
        // Disabled: the daily sync task never queues it, so the route answer is deterministic.
        seeded.accountId = insertAccount(sqlite, { connectionId, now: now(), status: "disabled" });
        seeded.token = new SessionStore(db).create("sync-wiring-test");
      },
    });
    const url = `http://127.0.0.1:${instance.port}/api/accounts/${seeded.accountId}/sync`;
    const anonymous = await fetch(url, { method: "POST", headers: { origin: "http://127.0.0.1" } });
    expect(anonymous.status).toBe(401);
    const response = await fetch(url, {
      method: "POST",
      headers: { origin: "http://127.0.0.1", cookie: `${SESSION_COOKIE}=${seeded.token}` },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "account_inactive" });
  });

  it("fails sync jobs permanently when Enable Banking is not configured", async () => {
    const captured: { sqlite?: Sqlite; jobId: number } = { jobId: 0 };
    await boot({
      bankingClient: null,
      mailer: null,
      seed: ({ sqlite, now }) => {
        captured.sqlite = sqlite;
        const connectionId = insertConnection(sqlite, { now: now() });
        const accountId = insertAccount(sqlite, { connectionId, now: now(), status: "disabled" });
        captured.jobId = new JobQueue(sqlite).enqueue(SYNC_ACCOUNT_JOB, {
          accountId,
          trigger: "manual",
        });
      },
    });
    await vi.waitFor(
      () => {
        const row = captured.sqlite
          ?.prepare("SELECT status, attempts, last_error AS lastError FROM jobs WHERE id = ?")
          .get(captured.jobId) as
          | { status: string; attempts: number; lastError: string | null }
          | undefined;
        expect(row).toMatchObject({ status: "failed", attempts: 1 });
        expect(row?.lastError).toContain("banking_not_configured");
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});
