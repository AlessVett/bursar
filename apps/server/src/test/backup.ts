import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveKey } from "../crypto";
import { openDatabase, runMigrations, type Sqlite } from "../db";
import { MIGRATIONS_DIR, type TestDatabase } from "./db";

/** Fixed test master key; the database passphrase is derived from it as in production. */
export const TEST_MASTER_KEY = Buffer.alloc(32, 7);

export function databasePassphrase(masterKey: Buffer): string {
  return deriveKey(masterKey, "database").toString("hex");
}

export interface KeyedTestDatabase extends TestDatabase {
  masterKey: Buffer;
  passphrase: string;
}

/**
 * Like `createTestDatabase()`, but keyed the way `startBursar` keys the real database (with
 * `deriveKey(masterKey, "database")`), so backups of it can be verified and restored with the
 * master key. The file is `<dir>/bursar.db`.
 */
export function createKeyedTestDatabase(masterKey: Buffer = TEST_MASTER_KEY): KeyedTestDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "bursar-backup-test-"));
  const file = path.join(dir, "bursar.db");
  const passphrase = databasePassphrase(masterKey);
  const opened = openDatabase(file, passphrase);
  runMigrations(opened.db, MIGRATIONS_DIR);
  return {
    ...opened,
    dir,
    file,
    masterKey,
    passphrase,
    dispose: () => {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Fictional rows in several M1 tables (raw SQL with the column names of the Task 6 schema):
 * 1 setting, 1 connection, 1 account, 3 transactions, 1 audit entry.
 */
export function seedBackupRows(sqlite: Sqlite, now: number): void {
  sqlite
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('locale', '\"en\"', ?)")
    .run(now);
  const connection = sqlite
    .prepare(
      `INSERT INTO bank_connections (aspsp_name, aspsp_country, provider_session_id, valid_until, created_at, updated_at)
       VALUES ('Banca Esempio', 'IT', 'session-fixture-0001', ?, ?, ?)`,
    )
    .run(now + 90 * 86_400_000, now, now);
  const account = sqlite
    .prepare(
      `INSERT INTO accounts (connection_id, identification_hash, currency, product, created_at, updated_at)
       VALUES (?, 'hash-fixture-0001', 'EUR', 'Conto Esempio', ?, ?)`,
    )
    .run(connection.lastInsertRowid, now, now);
  const insertTransaction = sqlite.prepare(
    `INSERT INTO transactions (account_id, fingerprint, status, booking_date, sort_date, amount_minor, currency,
       counterparty, search_text, raw_json, first_seen_at, last_seen_at)
     VALUES (?, ?, 'booked', ?, ?, ?, 'EUR', ?, ?, '{}', ?, ?)`,
  );
  const rows = [
    ["fp-1", "2026-11-02", 250_000, "Example Employer"],
    ["fp-2", "2026-11-03", -4_590, "Grocery Store"],
    ["fp-3", "2026-11-05", -12_000, "Utility Company"],
  ] as const;
  for (const [fingerprint, date, amount, counterparty] of rows) {
    insertTransaction.run(
      account.lastInsertRowid,
      fingerprint,
      date,
      date,
      amount,
      counterparty,
      counterparty.toLowerCase(),
      now,
      now,
    );
  }
  sqlite
    .prepare(
      "INSERT INTO audit_log (actor, action, target, details, at) VALUES ('user', 'settings.update', NULL, '{\"keys\":\"locale\"}', ?)",
    )
    .run(now);
}

/** Row count of every table, read the same way `restoreBackup` reports them. */
export function tableCounts(sqlite: Sqlite): Record<string, number> {
  const names = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    names.map(({ name }) => [
      name,
      (sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n,
    ]),
  );
}
