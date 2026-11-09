import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type OpenedDatabase, openDatabase, runMigrations } from "../db";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");
export const TEST_PASSPHRASE = "test-passphrase-0123456789abcdef";

export interface TestDatabase extends OpenedDatabase {
  dir: string;
  file: string;
  dispose(): void;
}

export function createTestDatabase(): TestDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "bursar-test-"));
  const file = path.join(dir, "test.db");
  const opened = openDatabase(file, TEST_PASSPHRASE);
  runMigrations(opened.db, MIGRATIONS_DIR);
  return {
    ...opened,
    dir,
    file,
    dispose: () => {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
