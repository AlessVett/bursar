import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OwnerStore } from "../auth/owner";
import { SessionStore } from "../auth/sessions";
import { loadConfig } from "../config";
import { deriveKey } from "../crypto";
import type { SeedContext } from "../server";
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from "../test/db";
import { seedQa } from "./seed";
import { QA_SEEDERS, type QaSeeder } from "./seeders";

const NOW = Date.UTC(2026, 10, 9, 9, 0, 0);

describe("seedQa", () => {
  let t: TestDatabase;
  let ctx: SeedContext;

  beforeEach(() => {
    t = createTestDatabase();
    const config = loadConfig({
      BURSAR_PUBLIC_URL: "http://127.0.0.1:4100",
      TZ: "Europe/Rome",
      BURSAR_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      BURSAR_DATA_DIR: t.dir,
      BURSAR_MIGRATIONS_DIR: MIGRATIONS_DIR,
    });
    ctx = { db: t.db, sqlite: t.sqlite, config, now: () => NOW };
  });
  afterEach(() => t.dispose());

  const owners = () => new OwnerStore(t.db, deriveKey(ctx.config.masterKey, "totp"));

  it("creates the owner and returns a session token the session store accepts", async () => {
    const { sessionToken } = await seedQa(ctx, { owner: true });
    expect(owners().exists()).toBe(true);
    expect(owners().get()?.lastTotpStep).toBe(0);
    expect(typeof sessionToken).toBe("string");
    expect(new SessionStore(t.db, () => NOW).validate(sessionToken ?? "")).toEqual(
      expect.any(Number),
    );
  });

  it("leaves the database without an owner and returns no token when asked", async () => {
    const { sessionToken } = await seedQa(ctx, { owner: false });
    expect(sessionToken).toBeNull();
    expect(owners().exists()).toBe(false);
  });

  it("runs every registered seeder exactly once with the seed context", async () => {
    const calls: SeedContext[] = [];
    const spy: QaSeeder = (seedCtx) => {
      calls.push(seedCtx);
    };
    QA_SEEDERS.push(spy);
    try {
      await seedQa(ctx, { owner: true });
    } finally {
      QA_SEEDERS.splice(QA_SEEDERS.indexOf(spy), 1);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(ctx);
  });
});
