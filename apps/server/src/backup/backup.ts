import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { openDatabase, type Sqlite } from "../db";
import type { ObjectStore } from "./object-store";

/** Name of the database file inside a backup set (and of the restored file). */
export const DB_FILE = "bursar.db";
/** Written last: a set without it is incomplete and ignored. */
export const MANIFEST_FILE = "manifest.json";

export interface BackupManifest {
  version: 1;
  setId: string;
  createdAt: string;
  schema: { migrations: number };
  files: { name: string; size: number; sha256: string }[];
}

export const backupManifestSchema = z.object({
  version: z.literal(1),
  setId: z.string(),
  createdAt: z.string(),
  schema: z.object({ migrations: z.number().int().nonnegative() }),
  files: z
    .array(
      z.object({
        name: z.string().min(1),
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1),
});

/** `YYYYMMDDTHHMMSSZ` in UTC, e.g. `20261109T020000Z`. Sorting the strings sorts by time. */
export function formatSetId(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** The instant a set id stands for, or null when `setId` is not a canonical set id. */
export function parseSetId(setId: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(setId);
  if (!match) return null;
  const n = (index: number) => Number(match[index]);
  const at = Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6));
  return formatSetId(at) === setId ? at : null;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** First line of an error message, at most 300 characters: what a run row and the panel show. */
export function reduceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n")[0]?.trim() || "Unknown error";
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/**
 * One or more stores refused the set. Stores earlier in the list may hold it already, so the
 * error carries the set id and size of the copy that was made.
 */
export class BackupUploadError extends Error {
  constructor(
    readonly setId: string,
    readonly sizeBytes: number,
    readonly failures: { kind: ObjectStore["kind"]; message: string }[],
  ) {
    super(`Upload failed for ${failures.map((f) => `${f.kind} (${f.message})`).join(", ")}`);
    this.name = "BackupUploadError";
  }
}

export interface CreateBackupDeps {
  sqlite: Sqlite;
  /** `deriveKey(masterKey, "database").toString("hex")`; used only to verify the copy. */
  dbPassphrase: string;
  /** Scratch directory for the copy; it is created 0700 and the copy is always removed. */
  workDir: string;
  /** Uploaded in order (the local store first, so a local copy exists even if S3 fails). */
  stores: readonly ObjectStore[];
  now: () => number;
}

/**
 * Writes one backup set: `VACUUM INTO` an encrypted copy (same key, no plaintext ever on disk),
 * opens the copy with the key and requires `PRAGMA integrity_check` = `ok`, then uploads
 * `<setId>/bursar.db` followed by `<setId>/manifest.json` to every store. Every store is
 * attempted; if any failed, a {@link BackupUploadError} is thrown after the last one.
 */
export async function createBackup(
  deps: CreateBackupDeps,
): Promise<{ setId: string; sizeBytes: number; manifest: BackupManifest }> {
  if (deps.stores.length === 0) throw new Error("createBackup needs at least one store");
  // VACUUM refuses to run inside a transaction; say so before touching the disk.
  if (deps.sqlite.inTransaction) throw new Error("Cannot back up from inside a transaction");
  const createdAt = deps.now();
  const setId = formatSetId(createdAt);
  await mkdir(deps.workDir, { recursive: true, mode: 0o700 });
  // Built from the set id and random bytes, never from user input; quoted for SQL anyway.
  const copy = path.join(deps.workDir, `${setId}-${randomBytes(6).toString("hex")}.db`);
  try {
    deps.sqlite.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    await chmod(copy, 0o600);
    const migrations = verifyCopy(copy, deps.dbPassphrase);
    // Hash after verifying: opening the copy switches its header to WAL mode.
    const data = await readFile(copy);
    const manifest: BackupManifest = {
      version: 1,
      setId,
      createdAt: new Date(createdAt).toISOString(),
      schema: { migrations },
      files: [{ name: DB_FILE, size: data.length, sha256: sha256Hex(data) }],
    };
    const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const failures: { kind: ObjectStore["kind"]; message: string }[] = [];
    for (const store of deps.stores) {
      try {
        await store.put(`${setId}/${DB_FILE}`, data);
        await store.put(`${setId}/${MANIFEST_FILE}`, manifestBody);
      } catch (error) {
        failures.push({ kind: store.kind, message: reduceError(error) });
      }
    }
    if (failures.length > 0) throw new BackupUploadError(setId, data.length, failures);
    return { setId, sizeBytes: data.length, manifest };
  } finally {
    await Promise.all([copy, `${copy}-wal`, `${copy}-shm`].map((f) => rm(f, { force: true })));
  }
}

/** Opens the copy with the database key; returns the number of applied migrations. */
function verifyCopy(file: string, passphrase: string): number {
  const opened = openDatabase(file, passphrase);
  try {
    const rows = opened.sqlite.pragma("integrity_check") as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error("The backup copy failed the integrity check");
    }
    const row = opened.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as {
      n: number;
    };
    return row.n;
  } finally {
    opened.close();
  }
}

/** Complete sets in a store (database and manifest both present), newest first. */
export async function listBackupSets(store: ObjectStore): Promise<string[]> {
  const files = new Map<string, Set<string>>();
  for (const { key } of await store.list("")) {
    const [setId, name, ...rest] = key.split("/");
    if (!setId || !name || rest.length > 0 || parseSetId(setId) === null) continue;
    const names = files.get(setId) ?? new Set<string>();
    names.add(name);
    files.set(setId, names);
  }
  return [...files]
    .filter(([, names]) => names.has(DB_FILE) && names.has(MANIFEST_FILE))
    .map(([setId]) => setId)
    .sort()
    .reverse();
}
