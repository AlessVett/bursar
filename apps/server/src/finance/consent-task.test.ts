import { Writable } from "node:stream";
import pino, { type Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnableBankingApi } from "../eb/client";
import { parseEbErrorBody } from "../eb/errors";
import expiredSession from "../eb/fixtures/error-expired-session.json";
import {
  BANK_NAME,
  createLifecycleFixture,
  DAY_MS,
  HOUR_MS,
  insertConnection,
  type LifecycleFixture,
  NOW,
  notificationRows,
  SESSION_ID,
  sessionStatus,
  stubBankingApi,
  TIMEZONE,
} from "../test/lifecycle";
import { consentTask, SESSION_STATUS_CHECK_INTERVAL_MS } from "./consent-task";

let fx: LifecycleFixture;
let logLines: string[];
let logger: Logger;

beforeEach(() => {
  fx = createLifecycleFixture();
  logLines = [];
  logger = pino(
    { level: "info" },
    new Writable({
      write(chunk, _encoding, done) {
        logLines.push(String(chunk));
        done();
      },
    }),
  );
});
afterEach(() => fx.dispose());

function makeTask(api: EnableBankingApi | null) {
  return consentTask({
    repo: fx.repo,
    api,
    notifications: fx.service,
    bus: fx.bus,
    timezone: TIMEZONE,
    now: () => fx.clock.now,
    logger,
  });
}

async function tick(api: EnableBankingApi | null = null): Promise<void> {
  await makeTask(api).run(new Date(fx.clock.now));
}

const expiringKeys = () =>
  notificationRows(fx)
    .filter((row) => row.event === "consent_expiring")
    .map((row) => row.dedupeKey);

function bankWith(getSession: EnableBankingApi["getSession"]) {
  const spy = vi.fn(getSession);
  return { api: stubBankingApi({ getSession: spy }), spy };
}

describe("consentTask thresholds", () => {
  it("is the consent-lifecycle task", () => {
    expect(makeTask(null).name).toBe("consent-lifecycle");
  });

  it("raises nothing 15 days before the consent ends", async () => {
    insertConnection(fx, { validUntil: NOW + 15 * DAY_MS });
    await tick();
    expect(notificationRows(fx)).toEqual([]);
  });

  it("raises the 14-day notice 14 days before", async () => {
    const validUntil = NOW + 14 * DAY_MS;
    const id = insertConnection(fx, { validUntil });
    await tick();
    expect(notificationRows(fx)).toEqual([
      {
        event: "consent_expiring",
        dedupeKey: `consent-expiring:${id}:${validUntil}:14`,
        params: { bankName: BANK_NAME, days: 14 },
        link: "/accounts",
      },
    ]);
  });

  it("keeps the 14-day notice down to 4 days", async () => {
    const validUntil = NOW + 4 * DAY_MS;
    const id = insertConnection(fx, { validUntil });
    await tick();
    expect(notificationRows(fx)).toEqual([
      {
        event: "consent_expiring",
        dedupeKey: `consent-expiring:${id}:${validUntil}:14`,
        params: { bankName: BANK_NAME, days: 4 },
        link: "/accounts",
      },
    ]);
  });

  it.each([3, 2])(
    "raises only the 3-day notice when the first evaluation finds %i days",
    async (days) => {
      const validUntil = NOW + days * DAY_MS;
      const id = insertConnection(fx, { validUntil });
      await tick();
      expect(notificationRows(fx)).toEqual([
        {
          event: "consent_expiring",
          dedupeKey: `consent-expiring:${id}:${validUntil}:3`,
          params: { bankName: BANK_NAME, days },
          link: "/accounts",
        },
      ]);
    },
  );

  it("uses the 3-day notice on the last day", async () => {
    const validUntil = NOW + 2 * HOUR_MS;
    const id = insertConnection(fx, { validUntil });
    await tick();
    expect(notificationRows(fx)).toEqual([
      {
        event: "consent_expiring",
        dedupeKey: `consent-expiring:${id}:${validUntil}:3`,
        params: { bankName: BANK_NAME, days: 0 },
        link: "/accounts",
      },
    ]);
  });

  it("counts local calendar days in the configured time zone", async () => {
    fx.clock.now = Date.UTC(2026, 10, 9, 22, 30); // 23:30 in Rome
    // 24 November 00:15 in Rome: 14 days and 45 minutes away, but 15 calendar days.
    insertConnection(fx, {
      validUntil: Date.UTC(2026, 10, 23, 23, 15),
      aspspName: "Northwind Bank",
    });
    // 23 November 23:45 in Rome: 14 calendar days.
    const validUntil = Date.UTC(2026, 10, 23, 22, 45);
    const id = insertConnection(fx, { validUntil });
    await tick();
    expect(expiringKeys()).toEqual([`consent-expiring:${id}:${validUntil}:14`]);
  });

  it("marks the connection expired once validUntil has passed", async () => {
    const validUntil = NOW - 60_000;
    const id = insertConnection(fx, { validUntil });
    await tick();
    expect(fx.repo.getConnection(id)?.status).toBe("expired");
    expect(notificationRows(fx).map((row) => [row.event, row.dedupeKey])).toEqual([
      ["consent_expired", `consent-expired:${id}:${validUntil}`],
    ]);
    expect(fx.events).toContainEqual({
      type: "connection.updated",
      connectionId: id,
      status: "expired",
    });
  });

  it("raises each notice once and escalates from 14 days to 3 days to expired", async () => {
    const validUntil = NOW + 14 * DAY_MS;
    const id = insertConnection(fx, { validUntil });
    await tick();
    await tick();
    expect(expiringKeys()).toEqual([`consent-expiring:${id}:${validUntil}:14`]);

    fx.clock.now += 11 * DAY_MS;
    await tick();
    await tick();
    expect(expiringKeys()).toEqual([
      `consent-expiring:${id}:${validUntil}:14`,
      `consent-expiring:${id}:${validUntil}:3`,
    ]);

    fx.clock.now = validUntil;
    await tick();
    await tick();
    expect(notificationRows(fx).map((row) => row.event)).toEqual([
      "consent_expiring",
      "consent_expiring",
      "consent_expired",
    ]);
  });

  it("starts the thresholds over after a renewal", async () => {
    const first = NOW + 3 * DAY_MS;
    const id = insertConnection(fx, { validUntil: first });
    await tick();

    const renewed = NOW + 90 * DAY_MS;
    fx.repo.updateConnection(id, { validUntil: renewed, renewedAt: NOW });
    await tick();
    expect(expiringKeys()).toEqual([`consent-expiring:${id}:${first}:3`]);

    fx.clock.now += 76 * DAY_MS;
    await tick();
    expect(expiringKeys()).toEqual([
      `consent-expiring:${id}:${first}:3`,
      `consent-expiring:${id}:${renewed}:14`,
    ]);
  });

  it("ignores removed connections and connections that already ended", async () => {
    insertConnection(fx, { validUntil: NOW + 2 * DAY_MS, removedAt: NOW - DAY_MS });
    const revoked = insertConnection(fx, { validUntil: NOW + 2 * DAY_MS, status: "revoked" });
    const failed = insertConnection(fx, { validUntil: NOW - DAY_MS, status: "error" });
    await tick();
    expect(notificationRows(fx)).toEqual([]);
    expect(fx.repo.getConnection(revoked)?.status).toBe("revoked");
    expect(fx.repo.getConnection(failed)?.status).toBe("error");
  });
});

describe("consentTask session status check", () => {
  it.each([
    ["EXPIRED", "expired", "consent_expired"],
    ["REVOKED", "revoked", "connection_error"],
    ["CLOSED", "error", "connection_error"],
    ["CANCELLED", "error", "connection_error"],
    ["INVALID", "error", "connection_error"],
  ] as const)("maps a %s session to %s", async (state, expected, event) => {
    const id = insertConnection(fx, { validUntil: NOW + 60 * DAY_MS });
    const { api, spy } = bankWith(async () => sessionStatus(state));
    await tick(api);
    expect(spy).toHaveBeenCalledWith(SESSION_ID);
    const connection = fx.repo.getConnection(id);
    expect(connection?.status).toBe(expected);
    expect(connection?.statusCheckedAt).toBe(NOW);
    expect(connection?.lastErrorCode).toBe(`SESSION_${state}`);
    expect(notificationRows(fx).map((row) => row.event)).toEqual([event]);
    expect(fx.events).toContainEqual({
      type: "connection.updated",
      connectionId: id,
      status: expected,
    });
  });

  it.each(["AUTHORIZED", "PENDING_AUTHORIZATION", "RETURNED_FROM_BANK"] as const)(
    "leaves a %s session alone",
    async (state) => {
      const id = insertConnection(fx, { validUntil: NOW + 60 * DAY_MS });
      const { api } = bankWith(async () => sessionStatus(state));
      await tick(api);
      const connection = fx.repo.getConnection(id);
      expect(connection?.status).toBe("active");
      expect(connection?.statusCheckedAt).toBe(NOW);
      expect(notificationRows(fx)).toEqual([]);
    },
  );

  it("asks the bank at most once every 24 hours", async () => {
    expect(SESSION_STATUS_CHECK_INTERVAL_MS).toBe(24 * HOUR_MS);
    insertConnection(fx, { validUntil: NOW + 60 * DAY_MS });
    const { api, spy } = bankWith(async () => sessionStatus("AUTHORIZED"));
    await tick(api);
    fx.clock.now += 23 * HOUR_MS;
    await tick(api);
    expect(spy).toHaveBeenCalledTimes(1);
    fx.clock.now += HOUR_MS;
    await tick(api);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("treats a re-authorisation error like the matching session state", async () => {
    const id = insertConnection(fx, { validUntil: NOW + 60 * DAY_MS });
    const { api } = bankWith(async () => {
      throw parseEbErrorBody(401, expiredSession);
    });
    await tick(api);
    expect(fx.repo.getConnection(id)).toMatchObject({
      status: "expired",
      lastErrorCode: "EXPIRED_SESSION",
    });
    expect(notificationRows(fx).map((row) => row.event)).toEqual(["consent_expired"]);
  });

  it("logs other errors with the code only and retries the next day", async () => {
    const id = insertConnection(fx, { validUntil: NOW + 60 * DAY_MS });
    const { api, spy } = bankWith(async () => {
      throw parseEbErrorBody(500, { message: "ASPSP error", code: 500, error: "ASPSP_ERROR" });
    });
    await tick(api);

    expect(fx.repo.getConnection(id)).toMatchObject({ status: "active", statusCheckedAt: NOW });
    const line = logLines.find((entry) => entry.includes("Bank session status check failed"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      connectionId: id,
      status: 500,
      code: "ASPSP_ERROR",
    });
    expect(logLines.join("")).not.toContain(SESSION_ID);

    fx.clock.now += HOUR_MS;
    await tick(api);
    expect(spy).toHaveBeenCalledTimes(1);
    fx.clock.now += 24 * HOUR_MS;
    await tick(api);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("logs a failure without an HTTP answer with null status and code", async () => {
    const id = insertConnection(fx, { validUntil: NOW + 60 * DAY_MS });
    const { api } = bankWith(async () => {
      throw new TypeError("fetch failed");
    });
    await tick(api);
    expect(fx.repo.getConnection(id)?.status).toBe("active");
    const line = logLines.find((entry) => entry.includes("Bank session status check failed"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ connectionId: id, status: null, code: null });
  });

  it("does not ask the bank about a consent that has lapsed by date", async () => {
    const id = insertConnection(fx, { validUntil: NOW - 1 });
    const { api, spy } = bankWith(async () => sessionStatus("AUTHORIZED"));
    await tick(api);
    expect(spy).not.toHaveBeenCalled();
    expect(fx.repo.getConnection(id)?.status).toBe("expired");
  });

  it("checks the session before raising an expiry notice", async () => {
    insertConnection(fx, { validUntil: NOW + 3 * DAY_MS });
    const { api } = bankWith(async () => sessionStatus("REVOKED"));
    await tick(api);
    expect(notificationRows(fx).map((row) => row.event)).toEqual(["connection_error"]);
  });
});
