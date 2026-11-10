import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "./audit";
import { auditLog } from "./db/schema";
import { createTestDatabase, type TestDatabase } from "./test/db";

describe("AuditLog", () => {
  let t: TestDatabase;
  let now: number;
  let audit: AuditLog;

  beforeEach(() => {
    t = createTestDatabase();
    now = 1_700_000_000_000;
    audit = new AuditLog(t.db, () => now);
  });
  afterEach(() => t.dispose());

  it("records the actor, action, target, details and time", () => {
    audit.record({
      actor: "user",
      action: "account.rename",
      target: "account:12",
      details: { changed: true, fields: 1, note: null },
    });
    now += 5_000;
    audit.record({ actor: "system", action: "backup.run" });

    const rows = t.db.select().from(auditLog).orderBy(asc(auditLog.id)).all();
    expect(rows).toEqual([
      {
        id: 1,
        actor: "user",
        action: "account.rename",
        target: "account:12",
        details: '{"changed":true,"fields":1,"note":null}',
        at: 1_700_000_000_000,
      },
      {
        id: 2,
        actor: "system",
        action: "backup.run",
        target: null,
        details: null,
        at: 1_700_000_005_000,
      },
    ]);
  });
});
