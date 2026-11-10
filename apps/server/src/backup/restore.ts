import { randomBytes } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveKey } from "../crypto";
import { type OpenedDatabase, openDatabase } from "../db";
import {
  type BackupManifest,
  backupManifestSchema,
  DB_FILE,
  MANIFEST_FILE,
  parseSetId,
  sha256Hex,
} from "./backup";
import { ObjectNotFoundError, type ObjectStore } from "./object-store";

export type RestoreErrorCode =
  | "set_not_found"
  | "checksum_mismatch"
  | "wrong_key"
  | "integrity_failed"
  | "target_not_empty";

export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RestoreError";
  }
}

export interface RestoreOptions {
  source: ObjectStore;
  setId: string;
  targetDir: string;
  masterKey: Buffer;
  /** Replace an existing `<targetDir>/bursar.db` (its `-wal`/`-shm` files are removed too). */
  force?: boolean;
}

/**
 * Restores one complete set into `<targetDir>/bursar.db` (mode 0600). The database file must
 * match the manifest's size and SHA-256, open with the key derived from `masterKey` and pass
 * `PRAGMA integrity_check`; only then is it renamed into place, so a failed restore leaves the
 * target directory as it was. Returns the row count of every table of the restored database.
 */
export async function restoreBackup(
  options: RestoreOptions,
): Promise<{ setId: string; tables: Record<string, number> }> {
  const { source, setId } = options;
  if (parseSetId(setId) === null) {
    throw new RestoreError("set_not_found", "There is no backup set with this id");
  }
  const manifest = await readManifest(source, setId);
  const entry = manifest.files.find((file) => file.name === DB_FILE);
  if (manifest.setId !== setId || !entry) {
    throw new RestoreError("set_not_found", "The manifest does not describe this backup set");
  }

  const targetDir = path.resolve(options.targetDir);
  const target = path.join(targetDir, DB_FILE);
  if (!options.force && (await exists(target))) {
    throw new RestoreError("target_not_empty", `${target} already exists; use force to replace it`);
  }

  let data: Buffer;
  try {
    data = await source.get(`${setId}/${DB_FILE}`);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw new RestoreError("set_not_found", "The backup set has no database file");
    }
    throw error;
  }
  if (data.length !== entry.size || sha256Hex(data) !== entry.sha256) {
    throw new RestoreError("checksum_mismatch", "The database file does not match the manifest");
  }

  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const temp = path.join(targetDir, `.${DB_FILE}.restore-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(temp, data, { mode: 0o600, flag: "wx" });
    const tables = inspect(temp, deriveKey(options.masterKey, "database").toString("hex"));
    if (options.force) {
      // A WAL left by the replaced database would be replayed onto the restored one.
      await Promise.all([`${target}-wal`, `${target}-shm`].map((f) => rm(f, { force: true })));
    }
    await rename(temp, target);
    return { setId, tables };
  } finally {
    await Promise.all([temp, `${temp}-wal`, `${temp}-shm`].map((f) => rm(f, { force: true })));
  }
}

async function readManifest(source: ObjectStore, setId: string): Promise<BackupManifest> {
  let raw: Buffer;
  try {
    raw = await source.get(`${setId}/${MANIFEST_FILE}`);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw new RestoreError("set_not_found", "There is no complete backup set with this id");
    }
    throw error;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    // Reported below as an invalid manifest.
  }
  const parsed = backupManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new RestoreError("set_not_found", "The backup set has no valid manifest");
  }
  return parsed.data;
}

/** Opens the restored copy with the key, checks it and counts the rows of every table. */
function inspect(file: string, passphrase: string): Record<string, number> {
  let opened: OpenedDatabase;
  try {
    opened = openDatabase(file, passphrase);
  } catch {
    // The checksum already matched, so the file is the one that was backed up: the key is wrong.
    throw new RestoreError("wrong_key", "The master key does not open this backup");
  }
  try {
    let ok = false;
    try {
      const rows = opened.sqlite.pragma("integrity_check") as { integrity_check: string }[];
      ok = rows.length === 1 && rows[0]?.integrity_check === "ok";
    } catch {
      // SQLCipher reports a page that fails its HMAC as SQLITE_CORRUPT.
      ok = false;
    }
    if (!ok) {
      throw new RestoreError(
        "integrity_failed",
        "The restored database failed the integrity check",
      );
    }
    const names = opened.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const tables: Record<string, number> = {};
    for (const { name } of names) {
      const row = opened.sqlite
        .prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`)
        .get() as { n: number };
      tables[name] = row.n;
    }
    return tables;
  } finally {
    opened.close();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
