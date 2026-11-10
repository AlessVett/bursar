import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_PASSPHRASE, type TestDatabase } from "../test/db";
import { openDatabase } from "./index";
import { owner } from "./schema";

function fileHeader(file: string): string {
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(16);
  readSync(fd, buffer, 0, 16, 0);
  closeSync(fd);
  return buffer.toString("latin1");
}

function insertOwner(t: TestDatabase): void {
  t.db
    .insert(owner)
    .values({
      id: 1,
      passwordHash: "hash",
      totpSecretEnc: Buffer.from("s"),
      lastTotpStep: 0,
      createdAt: new Date(0),
    })
    .run();
}

describe("encrypted database (gate V1)", () => {
  let t: TestDatabase | undefined;
  afterEach(() => t?.dispose());

  it("writes a file that is not readable as plain SQLite", () => {
    t = createTestDatabase();
    insertOwner(t);
    t.close();
    expect(fileHeader(t.file)).not.toBe("SQLite format 3\u0000");
  });

  it("reopens with the right passphrase and refuses a wrong one", () => {
    t = createTestDatabase();
    insertOwner(t);
    t.close();
    expect(() => openDatabase(t?.file ?? "", "wrong-passphrase")).toThrow(
      /Cannot open encrypted database/,
    );
    const reopened = openDatabase(t.file, TEST_PASSPHRASE);
    const row = reopened.db.select().from(owner).where(eq(owner.id, 1)).get();
    expect(row?.passwordHash).toBe("hash");
    reopened.close();
  });

  it("rejects an empty or too short passphrase without creating a plaintext file", () => {
    t = createTestDatabase();
    const file = `${t.dir}/weak.db`;
    expect(() => openDatabase(file, "")).toThrow(/passphrase must be at least/);
    expect(() => openDatabase(file, "short")).toThrow(/passphrase must be at least/);
    expect(existsSync(file)).toBe(false);
  });

  it("supports FTS5 full-text search", () => {
    t = createTestDatabase();
    t.sqlite.exec("CREATE VIRTUAL TABLE notes_fts USING fts5(body)");
    t.sqlite
      .prepare("INSERT INTO notes_fts (body) VALUES (?), (?)")
      .run("mortgage amortisation schedule", "grocery receipt");
    const rows = t.sqlite
      .prepare("SELECT body FROM notes_fts WHERE notes_fts MATCH ?")
      .all("amortisation") as { body: string }[];
    expect(rows.map((row) => row.body)).toEqual(["mortgage amortisation schedule"]);
  });
});

describe("M1 schema", () => {
  let t: TestDatabase;
  beforeEach(() => {
    t = createTestDatabase();
  });
  afterEach(() => t.dispose());

  const tableNames = (): string[] =>
    (
      t.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map((row) => row.name)
      .sort();

  const insertJob = (key: string | null, status: string): void => {
    t.sqlite
      .prepare(
        `INSERT INTO jobs (type, payload, status, run_after, created_at, updated_at, dedupe_key)
         VALUES ('sync', '{}', ?, 0, 0, 0, ?)`,
      )
      .run(status, key);
  };

  const insertConnection = (): number =>
    Number(
      t.sqlite
        .prepare(
          `INSERT INTO bank_connections
             (aspsp_name, aspsp_country, provider_session_id, valid_until, created_at, updated_at)
           VALUES ('Banca Esempio', 'IT', 'session', 0, 0, 0)`,
        )
        .run().lastInsertRowid,
    );

  const insertAccount = (connectionId: number): number =>
    Number(
      t.sqlite
        .prepare(
          `INSERT INTO accounts (connection_id, identification_hash, currency, created_at, updated_at)
           VALUES (?, 'hash', 'EUR', 0, 0)`,
        )
        .run(connectionId).lastInsertRowid,
    );

  const count = (table: string): number =>
    (t.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("creates every M1 table", () => {
    expect(tableNames()).toEqual(
      expect.arrayContaining([
        "accounts",
        "audit_log",
        "backup_runs",
        "balances",
        "bank_auth_requests",
        "bank_connections",
        "notifications",
        "settings",
        "sync_runs",
        "transactions",
      ]),
    );
  });

  it("keeps temp files in memory", () => {
    expect(t.sqlite.pragma("temp_store", { simple: true })).toBe(2);
  });

  it("allows one active job per dedupe key and any number without a key", () => {
    insertJob("sync:1", "queued");
    expect(() => insertJob("sync:1", "queued")).toThrow(/UNIQUE/);
    expect(() => insertJob("sync:1", "running")).toThrow(/UNIQUE/);
    insertJob("sync:2", "queued");
    insertJob(null, "queued");
    insertJob(null, "queued");
  });

  it("frees the dedupe key once the job has finished", () => {
    insertJob("sync:1", "succeeded");
    insertJob("sync:1", "failed");
    insertJob("sync:1", "queued");
    expect(() => insertJob("sync:1", "queued")).toThrow(/UNIQUE/);
    t.sqlite.prepare("UPDATE jobs SET status = 'succeeded' WHERE status = 'queued'").run();
    insertJob("sync:1", "queued");
  });

  it("enforces the foreign keys and cascades deletes from an account", () => {
    expect(() => insertAccount(999)).toThrow(/FOREIGN KEY/);
    const accountId = insertAccount(insertConnection());
    t.sqlite
      .prepare(
        `INSERT INTO balances (account_id, balance_type, amount_minor, currency, reference_date, as_of, fetched_at)
         VALUES (?, 'CLBD', 100, 'EUR', '2026-11-09', 0, 0)`,
      )
      .run(accountId);
    t.sqlite
      .prepare(
        `INSERT INTO sync_runs (account_id, trigger, status, started_at) VALUES (?, 'manual', 'running', 0)`,
      )
      .run(accountId);
    t.sqlite.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    expect(count("balances")).toBe(0);
    expect(count("sync_runs")).toBe(0);
  });

  it("refuses to delete a connection that still has accounts", () => {
    const connectionId = insertConnection();
    insertAccount(connectionId);
    expect(() =>
      t.sqlite.prepare("DELETE FROM bank_connections WHERE id = ?").run(connectionId),
    ).toThrow(/FOREIGN KEY/);
  });

  it("deletes the authorisation requests of a connection with it", () => {
    const connectionId = insertConnection();
    t.sqlite
      .prepare(
        `INSERT INTO bank_auth_requests
           (state_hash, purpose, connection_id, aspsp_name, aspsp_country, valid_until, created_at, expires_at)
         VALUES ('h', 'renew', ?, 'Banca Esempio', 'IT', 0, 0, 0)`,
      )
      .run(connectionId);
    t.sqlite.prepare("DELETE FROM bank_connections WHERE id = ?").run(connectionId);
    expect(count("bank_auth_requests")).toBe(0);
  });

  it("keeps one balance per account, type and reference date", () => {
    const accountId = insertAccount(insertConnection());
    const insert = (type: string, day: string): void => {
      t.sqlite
        .prepare(
          `INSERT INTO balances (account_id, balance_type, amount_minor, currency, reference_date, as_of, fetched_at)
           VALUES (?, ?, 1, 'EUR', ?, 0, 0)`,
        )
        .run(accountId, type, day);
    };
    insert("CLBD", "2026-11-09");
    insert("ITAV", "2026-11-09");
    insert("CLBD", "2026-11-08");
    expect(() => insert("CLBD", "2026-11-09")).toThrow(/UNIQUE/);
  });

  it("keeps one transaction per account and fingerprint", () => {
    const accountId = insertAccount(insertConnection());
    const insert = (fingerprint: string): void => {
      t.sqlite
        .prepare(
          `INSERT INTO transactions
             (account_id, fingerprint, status, sort_date, amount_minor, currency, search_text, raw_json, first_seen_at, last_seen_at)
           VALUES (?, ?, 'booked', '2026-11-09', -100, 'EUR', '', '{}', 0, 0)`,
        )
        .run(accountId, fingerprint);
    };
    insert("a");
    insert("b");
    expect(() => insert("a")).toThrow(/UNIQUE/);
  });

  it("keeps one notification per dedupe key", () => {
    const insert = (key: string): void => {
      t.sqlite
        .prepare(
          `INSERT INTO notifications (event, dedupe_key, params, created_at, email_status)
           VALUES ('sync_failing', ?, '{}', 0, 'skipped')`,
        )
        .run(key);
    };
    insert("k1");
    insert("k2");
    expect(() => insert("k1")).toThrow(/UNIQUE/);
  });
});
