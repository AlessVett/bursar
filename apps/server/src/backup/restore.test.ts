import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db";
import {
  createKeyedTestDatabase,
  databasePassphrase,
  type KeyedTestDatabase,
  seedBackupRows,
  tableCounts,
} from "../test/backup";
import { createFakeS3 } from "../test/fake-s3";
import { createBackup, DB_FILE, MANIFEST_FILE, sha256Hex } from "./backup";
import { LocalDirStore, type ObjectStore } from "./object-store";
import { RestoreError, restoreBackup } from "./restore";
import { S3Store } from "./s3-store";

const NOW = Date.UTC(2026, 10, 9, 2, 0, 0);
const SET_ID = "20261109T020000Z";

describe("backup and restore round trip", () => {
  let t: KeyedTestDatabase;
  let scratch: string;
  let storeDir: string;
  let store: LocalDirStore;
  let target: string;

  beforeEach(async () => {
    t = createKeyedTestDatabase();
    seedBackupRows(t.sqlite, NOW);
    scratch = mkdtempSync(path.join(tmpdir(), "bursar-restore-"));
    storeDir = path.join(scratch, "store");
    store = new LocalDirStore(storeDir);
    target = path.join(scratch, "target");
    await backupTo(store);
  });
  afterEach(() => {
    t.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  const backupTo = (destination: ObjectStore) =>
    createBackup({
      sqlite: t.sqlite,
      dbPassphrase: t.passphrase,
      workDir: path.join(scratch, "work"),
      stores: [destination],
      now: () => NOW,
    });

  const restore = (overrides: Partial<Parameters<typeof restoreBackup>[0]> = {}) =>
    restoreBackup({
      source: store,
      setId: SET_ID,
      targetDir: target,
      masterKey: t.masterKey,
      ...overrides,
    });

  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (error: unknown) => (error instanceof RestoreError ? error.code : String(error)),
    );

  /** The target holds no database and no temporary file. */
  const expectTargetUntouched = () => {
    expect(existsSync(path.join(target, DB_FILE))).toBe(false);
    if (existsSync(target)) {
      expect(readdirSync(target).filter((name) => name.includes("restore"))).toEqual([]);
    }
  };

  it("restores every row into a private file that opens with the master key", async () => {
    const result = await restore();

    expect(result.setId).toBe(SET_ID);
    const expectedCounts = tableCounts(t.sqlite);
    expect(result.tables).toEqual(expectedCounts);
    expect(result.tables).toMatchObject({
      settings: 1,
      bank_connections: 1,
      accounts: 1,
      transactions: 3,
      audit_log: 1,
    });
    const file = path.join(target, DB_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(target)).toEqual([DB_FILE]);

    const restored = openDatabase(file, databasePassphrase(t.masterKey));
    try {
      expect(tableCounts(restored.sqlite)).toEqual(expectedCounts);
      const sample = "SELECT * FROM transactions WHERE fingerprint = 'fp-2'";
      expect(restored.sqlite.prepare(sample).get()).toEqual(t.sqlite.prepare(sample).get());
    } finally {
      restored.close();
    }
  });

  it("round-trips through an S3-compatible target too", async () => {
    const fake = createFakeS3({ pageSize: 1 });
    const s3 = new S3Store({
      endpoint: new URL("https://s3.example.test"),
      region: "auto",
      bucket: "bursar-backups",
      prefix: "bursar",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "s3-secret-access-key-value-0123456789",
      fetch: fake.fetch,
    });
    await backupTo(s3);
    expect([...fake.objects.keys()].sort()).toEqual([
      `bursar/${SET_ID}/${DB_FILE}`,
      `bursar/${SET_ID}/${MANIFEST_FILE}`,
    ]);

    const result = await restore({ source: s3 });
    expect(result.tables).toEqual(tableCounts(t.sqlite));
  });

  it("refuses a database file that does not match the manifest", async () => {
    const file = path.join(storeDir, SET_ID, DB_FILE);
    const bytes = readFileSync(file);
    bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 0xff;
    writeFileSync(file, bytes);

    expect(await codeOf(restore())).toBe("checksum_mismatch");
    expectTargetUntouched();
  });

  it("refuses a master key that does not open the backup", async () => {
    expect(await codeOf(restore({ masterKey: Buffer.alloc(32, 9) }))).toBe("wrong_key");
    expectTargetUntouched();
  });

  it("reports a database that fails the integrity check", async () => {
    // Corrupt the last page and rewrite the manifest so that the checksum still matches.
    const file = path.join(storeDir, SET_ID, DB_FILE);
    const bytes = readFileSync(file);
    bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 0xff;
    writeFileSync(file, bytes);
    const manifestFile = path.join(storeDir, SET_ID, MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    manifest.files[0].sha256 = sha256Hex(bytes);
    writeFileSync(manifestFile, JSON.stringify(manifest));

    expect(await codeOf(restore())).toBe("integrity_failed");
    expectTargetUntouched();
  });

  it("reports a set without a manifest, an unknown set and a malformed id as not found", async () => {
    expect(await codeOf(restore({ setId: "20991231T000000Z" }))).toBe("set_not_found");
    expect(await codeOf(restore({ setId: "../../etc" }))).toBe("set_not_found");
    rmSync(path.join(storeDir, SET_ID, MANIFEST_FILE));
    expect(await codeOf(restore())).toBe("set_not_found");
    expectTargetUntouched();
  });

  it("reports a manifest without its database file as not found", async () => {
    rmSync(path.join(storeDir, SET_ID, DB_FILE));
    expect(await codeOf(restore())).toBe("set_not_found");
  });

  it("refuses an existing database unless forced, and then drops its stale WAL", async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, DB_FILE), "an older database");
    writeFileSync(path.join(target, `${DB_FILE}-wal`), "a stale write-ahead log");

    expect(await codeOf(restore())).toBe("target_not_empty");
    expect(readFileSync(path.join(target, DB_FILE), "utf8")).toBe("an older database");

    const result = await restore({ force: true });
    expect(result.tables.transactions).toBe(3);
    expect(existsSync(path.join(target, `${DB_FILE}-wal`))).toBe(false);
    const restored = openDatabase(path.join(target, DB_FILE), databasePassphrase(t.masterKey));
    restored.close();
  });
});
