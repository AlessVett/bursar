import type { CompleteConnectionResponse } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../audit";
import { AspspCache } from "../eb/aspsp-cache";
import { EventBus } from "../events/bus";
import { JobQueue } from "../jobs/queue";
import { SettingsStore } from "../settings/store";
import { createTestApp, type TestApp } from "../test/app";
import {
  AUTH_URL,
  accountResource,
  BANK_NAME,
  ebError,
  StubBank,
  sessionFixture,
} from "../test/bank-stub";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { bankCallbackRoutes } from "./callback";
import { ConnectService } from "./connect";
import { connectRoutes } from "./connect-routes";
import { FinanceRepository } from "./repository";

const START = Date.parse("2026-11-09T10:00:00.000Z");
const NOT_CONFIGURED = {
  error: "Enable Banking is not configured",
  code: "banking_not_configured",
};
const INVALID = { error: "Invalid request", code: "invalid_request" };

describe("connectRoutes", () => {
  let t: TestDatabase;
  let now: number;
  let bank: StubBank;
  let repo: FinanceRepository;
  let test: TestApp;

  async function build(withService: boolean): Promise<void> {
    const clock = () => now;
    const service = withService
      ? new ConnectService({
          repo,
          api: bank,
          aspsps: new AspspCache(bank, clock),
          queue: new JobQueue(t.sqlite, clock),
          bus: new EventBus(),
          audit: new AuditLog(t.db, clock),
          settings: new SettingsStore(t.db, clock),
          publicUrl: new URL("https://bursar.example.test"),
          timezone: "Europe/Rome",
          now: clock,
        })
      : null;
    test = await createTestApp({
      database: t,
      now: clock,
      routers: [{ prefix: "/api/connections", router: connectRoutes({ service }) }],
      publicRouters: [{ prefix: "/api/banks/callback", router: bankCallbackRoutes() }],
    });
  }

  const post = (path: string, body: unknown) => test.json(path, { method: "POST", body });

  async function connected(): Promise<number> {
    bank.willReturn("code-1", sessionFixture(1, [accountResource("current")]));
    await post("/api/connections", { aspspName: BANK_NAME, aspspCountry: "IT" });
    const result = await post("/api/connections/complete", {
      state: bank.lastState(),
      code: "code-1",
    });
    const { connectionId } = result.body as CompleteConnectionResponse;
    if (connectionId === null) throw new Error("the connection was not created");
    return connectionId;
  }

  beforeEach(() => {
    t = createTestDatabase();
    now = START;
    bank = new StubBank();
    repo = new FinanceRepository(t.db, () => now);
  });
  afterEach(() => t.dispose());

  it("answers 503 on every route when Enable Banking is not configured", async () => {
    await build(false);
    const calls: [string, unknown][] = [
      ["/api/connections", { aspspName: BANK_NAME, aspspCountry: "IT" }],
      ["/api/connections/complete", { state: "state-value-000000001", code: "code-1" }],
      ["/api/connections/1/renew", {}],
    ];
    for (const [path, body] of calls) {
      expect(await post(path, body)).toMatchObject({ status: 503, body: NOT_CONFIGURED });
    }
  });

  it("starts a connection and validates the body", async () => {
    await build(true);
    expect(
      await post("/api/connections", { aspspName: BANK_NAME, aspspCountry: "IT", consentDays: 90 }),
    ).toMatchObject({ status: 200, body: { redirectUrl: AUTH_URL } });
    const invalidBodies: unknown[] = [
      { aspspCountry: "IT" },
      { aspspName: BANK_NAME, aspspCountry: "it" },
      { aspspName: BANK_NAME, aspspCountry: "IT", consentDays: 0 },
      { aspspName: BANK_NAME, aspspCountry: "IT", consentDays: 366 },
      null,
    ];
    for (const body of invalidBodies) {
      expect(await post("/api/connections", body)).toMatchObject({ status: 400, body: INVALID });
    }
    expect(bank.startCalls).toHaveLength(1);
  });

  it("answers 404 for an unknown bank and 502 with the code for a misconfiguration", async () => {
    await build(true);
    expect(
      await post("/api/connections", { aspspName: "Banca Inesistente", aspspCountry: "IT" }),
    ).toMatchObject({ status: 404, body: { error: "Unknown bank", code: "unknown_bank" } });
    bank.startError = ebError(400, "REDIRECT_URI_NOT_ALLOWED", "Redirect URI not allowed");
    const misconfigured = await post("/api/connections", {
      aspspName: BANK_NAME,
      aspspCountry: "IT",
    });
    expect(misconfigured).toMatchObject({
      status: 502,
      body: { error: "The bank service rejected the request", code: "REDIRECT_URI_NOT_ALLOWED" },
    });
  });

  it("completes once and answers 410 on reuse without echoing the state or the code", async () => {
    await build(true);
    bank.willReturn("code-1", sessionFixture(1, [accountResource("current")]));
    await post("/api/connections", { aspspName: BANK_NAME, aspspCountry: "IT" });
    const state = bank.lastState();
    const first = await post("/api/connections/complete", { state, code: "code-1" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: "connected", bankName: BANK_NAME });
    const reused = await post("/api/connections/complete", { state, code: "code-1" });
    expect(reused).toMatchObject({ status: 410, body: { code: "state_invalid" } });
    expect(JSON.stringify(reused.body)).not.toContain(state);
    expect(JSON.stringify(reused.body)).not.toContain("code-1");
  });

  it("rejects a completion without code or error and a malformed body", async () => {
    await build(true);
    await post("/api/connections", { aspspName: BANK_NAME, aspspCountry: "IT" });
    expect(await post("/api/connections/complete", { state: bank.lastState() })).toMatchObject({
      status: 400,
      body: INVALID,
    });
    expect(await post("/api/connections/complete", { state: "short", code: "x" })).toMatchObject({
      status: 400,
      body: INVALID,
    });
  });

  it("requires a session and the panel origin for the code exchange", async () => {
    await build(true);
    const body = JSON.stringify({ state: "state-value-000000001", code: "code-1" });
    const anonymous = await test.app.request("/api/connections/complete", {
      method: "POST",
      headers: { origin: test.origin, "content-type": "application/json" },
      body,
    });
    expect(anonymous.status).toBe(401);
    const crossSite = await test.app.request("/api/connections/complete", {
      method: "POST",
      headers: { cookie: test.cookie, "content-type": "application/json" },
      body,
    });
    expect(crossSite.status).toBe(403);
    expect(bank.exchangedCodes).toEqual([]);
  });

  it("renews a live connection and rejects unknown, removed and malformed ones", async () => {
    await build(true);
    const connectionId = await connected();
    expect(await post(`/api/connections/${connectionId}/renew`, { consentDays: 30 })).toMatchObject(
      {
        status: 200,
        body: { redirectUrl: AUTH_URL },
      },
    );
    const noBody = await test.app.request(`/api/connections/${connectionId}/renew`, {
      method: "POST",
      headers: { origin: test.origin, cookie: test.cookie },
    });
    expect(noBody.status).toBe(200);
    expect(await post(`/api/connections/${connectionId}/renew`, { consentDays: 0 })).toMatchObject({
      status: 400,
      body: INVALID,
    });
    for (const id of ["abc", "0", "999"]) {
      expect(await post(`/api/connections/${id}/renew`, {})).toMatchObject({
        status: 404,
        body: { code: "not_found" },
      });
    }
    repo.updateConnection(connectionId, { removedAt: now });
    expect(await post(`/api/connections/${connectionId}/renew`, {})).toMatchObject({
      status: 409,
      body: { code: "connection_removed" },
    });
  });
});
