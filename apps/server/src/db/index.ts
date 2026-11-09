import Database from "better-sqlite3-multiple-ciphers";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Sqlite = Database.Database;
export type BursarDb = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  sqlite: Sqlite;
  db: BursarDb;
  close(): void;
}

export function openDatabase(file: string, passphrase: string): OpenedDatabase {
  const sqlite = new Database(file);
  try {
    sqlite.pragma("cipher = 'sqlcipher'");
    sqlite.pragma("legacy = 4");
    sqlite.pragma(`key = '${passphrase.replaceAll("'", "''")}'`);
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
  } catch (error) {
    sqlite.close();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot open encrypted database at ${file}: ${reason}`);
  }
  const db = drizzle({ client: sqlite, schema });
  return { sqlite, db, close: () => sqlite.close() };
}

export function runMigrations(db: BursarDb, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
}
