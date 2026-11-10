import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../test/app";
import {
  BANK_NAME,
  createLifecycleFixture,
  DAY_MS,
  insertAccount,
  insertBalance,
  insertConnection,
  insertTransactions,
  type LifecycleFixture,
  NOW,
  stubBankingApi,
} from "../test/lifecycle";
import { ConnectionLifecycle } from "./lifecycle";
import { lifecycleRoutes } from "./lifecycle-routes";

const NOT_FOUND = { error: "Not found", code: "not_found" };

let fx: LifecycleFixture;
let ta: TestApp;
let connectionId: number;
let first: number;

beforeEach(async () => {
  fx = createLifecycleFixture();
  connectionId = insertConnection(fx, { validUntil: NOW + 90 * DAY_MS });
  first = insertAccount(fx, connectionId, { nickname: "Conto spese" });
  const second = insertAccount(fx, connectionId);
  insertTransactions(fx, first, 3);
  insertTransactions(fx, second, 2);
  insertBalance(fx, first);
  const lifecycle = new ConnectionLifecycle({
    repo: fx.repo,
    api: stubBankingApi({ deleteSession: async () => {} }),
    queue: fx.queue,
    bus: fx.bus,
    audit: fx.audit,
    now: () => fx.clock.now,
  });
  ta = await createTestApp({
    database: fx.t,
    routers: [{ prefix: "/api", router: lifecycleRoutes({ lifecycle }) }],
    now: () => fx.clock.now,
  });
});
afterEach(() => fx.dispose());

describe("lifecycle routes", () => {
  it("previews a disconnect", async () => {
    expect(await ta.json(`/api/connections/${connectionId}/removal-preview`)).toMatchObject({
      status: 200,
      body: { bankName: BANK_NAME, accounts: 2, transactions: 5 },
    });
  });

  it("answers 404 for unknown or malformed connection ids without echoing them", async () => {
    for (const id of ["999", "abc", "0", "-1", "1.5"]) {
      const response = await ta.json(`/api/connections/${id}/removal-preview`);
      expect(response).toMatchObject({ status: 404, body: NOT_FOUND });
    }
  });

  it("disconnects once and answers 409 afterwards", async () => {
    const path = `/api/connections/${connectionId}`;
    expect(await ta.json(path, { method: "DELETE" })).toMatchObject({
      status: 200,
      body: { removedAccounts: 2 },
    });
    expect(await ta.json(path, { method: "DELETE" })).toMatchObject({
      status: 409,
      body: { error: "The connection is already removed", code: "already_removed" },
    });
  });

  it("answers 404 when disconnecting an unknown connection", async () => {
    expect(await ta.json("/api/connections/999", { method: "DELETE" })).toMatchObject({
      status: 404,
      body: NOT_FOUND,
    });
  });

  it("rejects a disconnect without the panel origin", async () => {
    const response = await ta.app.request(`/api/connections/${connectionId}`, {
      method: "DELETE",
      headers: { cookie: ta.cookie },
    });
    expect(response.status).toBe(403);
    expect(fx.repo.getConnection(connectionId)?.removedAt).toBeNull();
  });

  it("requires an explicit confirmation to purge", async () => {
    await ta.json(`/api/connections/${connectionId}`, { method: "DELETE" });
    const path = `/api/accounts/${first}/purge`;
    for (const body of [undefined, {}, { confirm: "yes" }, { confirm: false }]) {
      expect(await ta.json(path, { method: "POST", body })).toMatchObject({
        status: 400,
        body: { error: "Purging needs an explicit confirmation", code: "confirmation_required" },
      });
    }
    expect(fx.repo.countTransactions(first).total).toBe(3);
  });

  it("refuses to purge an account that is not removed", async () => {
    expect(
      await ta.json(`/api/accounts/${first}/purge`, { method: "POST", body: { confirm: true } }),
    ).toMatchObject({
      status: 409,
      body: { error: "Only a removed account can be purged", code: "account_not_removed" },
    });
  });

  it("purges a removed account and answers 404 for an unknown one", async () => {
    await ta.json(`/api/connections/${connectionId}`, { method: "DELETE" });
    expect(
      await ta.json(`/api/accounts/${first}/purge`, { method: "POST", body: { confirm: true } }),
    ).toMatchObject({ status: 200, body: { transactions: 3, balances: 1 } });
    expect(
      await ta.json("/api/accounts/999/purge", { method: "POST", body: { confirm: true } }),
    ).toMatchObject({ status: 404, body: NOT_FOUND });
  });

  it("marks every response as not cacheable", async () => {
    const preview = await ta.json(`/api/connections/${connectionId}/removal-preview`);
    const missing = await ta.json("/api/connections/999/removal-preview");
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });
});
