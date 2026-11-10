import { syncQueuedResponseSchema } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobQueue } from "../jobs/queue";
import { syncDedupeKey } from "../jobs/types";
import { createTestApp, type TestApp } from "../test/app";
import { createTestDatabase, type TestDatabase } from "../test/db";
import {
  insertAccount,
  insertConnection,
  SYNC_TEST_NOW,
  SYNC_TEST_TIMEZONE,
} from "../test/sync-fixture";
import { FinanceRepository } from "./repository";
import { enqueueAccountSync } from "./sync";
import { syncRoutes } from "./sync-routes";

const HOUR_MS = 3_600_000;
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) ExampleBrowser/1.0";

describe("sync routes", () => {
  let t: TestDatabase;
  let clock: { now: number };
  let queue: JobQueue;
  let clientIp: string;
  let api: TestApp;
  let connectionId: number;
  let accountId: number;

  beforeEach(async () => {
    t = createTestDatabase();
    clock = { now: SYNC_TEST_NOW };
    const now = () => clock.now;
    const repo = new FinanceRepository(t.db, now);
    queue = new JobQueue(t.sqlite, now);
    clientIp = "10.0.0.8";
    api = await createTestApp({
      database: t,
      routers: [
        {
          prefix: "/api",
          router: syncRoutes({
            repo,
            queue,
            clientIp: () => clientIp,
            timezone: SYNC_TEST_TIMEZONE,
            now,
          }),
        },
      ],
      now,
    });
    connectionId = insertConnection(t.sqlite, { now: clock.now });
    accountId = insertAccount(t.sqlite, { connectionId, now: clock.now });
  });
  afterEach(() => t.dispose());

  function post(path: string) {
    return api.json(path, { method: "POST" });
  }

  /** POST with explicit browser headers (the `json()` helper sends none of these). */
  function postWithHeaders(path: string, headers: Record<string, string>) {
    return api.app.request(path, {
      method: "POST",
      headers: { cookie: api.cookie, origin: api.origin, ...headers },
    });
  }

  function nextPayload(): unknown {
    return queue.claimNext()?.payload;
  }

  it("queues a manual sync without PSU headers for a private client address", async () => {
    const response = await post(`/api/accounts/${accountId}/sync`);
    expect(response.status).toBe(202);
    expect(syncQueuedResponseSchema.parse(response.body)).toEqual({ queued: 1 });
    expect(nextPayload()).toEqual({ accountId, trigger: "manual" });
  });

  it("attaches PSU headers for a public client address", async () => {
    clientIp = "203.0.113.9";
    const response = await postWithHeaders(`/api/accounts/${accountId}/sync`, {
      "user-agent": BROWSER_UA,
      accept: "application/json",
      "accept-language": "it-IT,it;q=0.9",
    });
    expect(response.status).toBe(202);
    expect(nextPayload()).toEqual({
      accountId,
      trigger: "manual",
      psu: {
        ipAddress: "203.0.113.9",
        userAgent: BROWSER_UA,
        accept: "application/json",
        acceptLanguage: "it-IT,it;q=0.9",
      },
    });
  });

  it("sends no PSU headers without a user agent", async () => {
    clientIp = "203.0.113.9";
    const response = await postWithHeaders(`/api/accounts/${accountId}/sync`, {});
    expect(response.status).toBe(202);
    expect(nextPayload()).toEqual({ accountId, trigger: "manual" });
  });

  it("answers 409 sync_in_progress while a sync is queued", async () => {
    expect((await post(`/api/accounts/${accountId}/sync`)).status).toBe(202);
    expect(await post(`/api/accounts/${accountId}/sync`)).toMatchObject({
      status: 409,
      body: { code: "sync_in_progress" },
    });
  });

  it("answers 404 for an unknown or malformed account id", async () => {
    for (const path of [
      "/api/accounts/999/sync",
      "/api/accounts/abc/sync",
      "/api/accounts/0/sync",
    ]) {
      expect(await post(path)).toMatchObject({
        status: 404,
        body: { error: "Not found", code: "not_found" },
      });
    }
  });

  interface RefusalCase {
    label: string;
    code: string;
    setup: () => number;
    retryAt?: number;
  }

  it.each<RefusalCase>([
    {
      label: "a disabled account",
      code: "account_inactive",
      setup: () => insertAccount(t.sqlite, { connectionId, now: clock.now, status: "disabled" }),
    },
    {
      label: "an account without a provider id",
      code: "account_inactive",
      setup: () =>
        insertAccount(t.sqlite, { connectionId, now: clock.now, providerAccountUid: null }),
    },
    {
      label: "an account of an expired connection",
      code: "connection_inactive",
      setup: () =>
        insertAccount(t.sqlite, {
          connectionId: insertConnection(t.sqlite, {
            now: clock.now,
            validUntil: clock.now - HOUR_MS,
          }),
          now: clock.now,
        }),
    },
    {
      label: "a paused account",
      code: "rate_limited",
      setup: () =>
        insertAccount(t.sqlite, {
          connectionId,
          now: clock.now,
          rateLimitedUntil: SYNC_TEST_NOW + 3 * HOUR_MS,
        }),
      retryAt: SYNC_TEST_NOW + 3 * HOUR_MS,
    },
  ])("refuses $label with $code", async ({ setup, code, retryAt }) => {
    const id = setup();
    const response = await post(`/api/accounts/${id}/sync`);
    expect(response.status).toBe(409);
    expect(response.body).toEqual(
      retryAt === undefined
        ? { error: expect.any(String), code }
        : { error: expect.any(String), code, retryAt },
    );
    expect(queue.findActive(syncDedupeKey(id))).toBeNull();
  });

  it("queues every eligible account of a connection", async () => {
    const second = insertAccount(t.sqlite, { connectionId, now: clock.now });
    insertAccount(t.sqlite, { connectionId, now: clock.now, status: "disabled" });
    const response = await post(`/api/connections/${connectionId}/sync`);
    expect(response).toMatchObject({ status: 202, body: { queued: 2 } });
    expect(queue.activeKeys("sync:")).toEqual(
      new Set([syncDedupeKey(accountId), syncDedupeKey(second)]),
    );
  });

  it("skips accounts that are already syncing", async () => {
    const second = insertAccount(t.sqlite, { connectionId, now: clock.now });
    enqueueAccountSync(queue, accountId, "background");
    expect(await post(`/api/connections/${connectionId}/sync`)).toMatchObject({
      status: 202,
      body: { queued: 1 },
    });
    expect(queue.findActive(syncDedupeKey(second))).not.toBeNull();
  });

  it("answers nothing_to_sync when a connection has no eligible account", async () => {
    const lonely = insertConnection(t.sqlite, { now: clock.now });
    insertAccount(t.sqlite, { connectionId: lonely, now: clock.now, status: "disabled" });
    expect(await post(`/api/connections/${lonely}/sync`)).toMatchObject({
      status: 409,
      body: { code: "nothing_to_sync" },
    });
  });

  it("answers sync_in_progress when every account of a connection is already syncing", async () => {
    enqueueAccountSync(queue, accountId, "background");
    expect(await post(`/api/connections/${connectionId}/sync`)).toMatchObject({
      status: 409,
      body: { code: "sync_in_progress" },
    });
  });

  it("answers rate_limited with the earliest retryAt when every account is paused", async () => {
    const paused = insertConnection(t.sqlite, { now: clock.now });
    insertAccount(t.sqlite, {
      connectionId: paused,
      now: clock.now,
      rateLimitedUntil: SYNC_TEST_NOW + 3 * HOUR_MS,
    });
    insertAccount(t.sqlite, {
      connectionId: paused,
      now: clock.now,
      rateLimitedUntil: SYNC_TEST_NOW + HOUR_MS,
    });
    expect(await post(`/api/connections/${paused}/sync`)).toMatchObject({
      status: 409,
      body: { code: "rate_limited", retryAt: SYNC_TEST_NOW + HOUR_MS },
    });
  });

  it("answers 404 for an unknown connection and 409 for an inactive one", async () => {
    expect(await post("/api/connections/999/sync")).toMatchObject({
      status: 404,
      body: { code: "not_found" },
    });
    const revoked = insertConnection(t.sqlite, { now: clock.now, status: "revoked" });
    insertAccount(t.sqlite, { connectionId: revoked, now: clock.now });
    expect(await post(`/api/connections/${revoked}/sync`)).toMatchObject({
      status: 409,
      body: { code: "connection_inactive" },
    });
  });

  it("requires a session", async () => {
    const response = await api.app.request(`/api/accounts/${accountId}/sync`, {
      method: "POST",
      headers: { origin: api.origin },
    });
    expect(response.status).toBe(401);
    expect(queue.findActive(syncDedupeKey(accountId))).toBeNull();
  });
});
