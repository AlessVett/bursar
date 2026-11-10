import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db";
import { createKeyedTestDatabase, type KeyedTestDatabase, seedBackupRows } from "../test/backup";
import {
  type BackupManifest,
  BackupUploadError,
  createBackup,
  DB_FILE,
  formatSetId,
  listBackupSets,
  MANIFEST_FILE,
  parseSetId,
  reduceError,
  sha256Hex,
} from "./backup";
import { LocalDirStore, type ObjectStore } from "./object-store";

const NOW = Date.UTC(2026, 10, 9, 2, 0, 0, 345);

/** Records the order of `put` calls; can be told to refuse every write. */
class RecordingStore implements ObjectStore {
  readonly puts: string[] = [];
  readonly objects = new Map<string, Buffer>();
  constructor(
    readonly kind: "local" | "s3",
    private readonly failure: Error | null = null,
  ) {}
  async put(key: string, body: Buffer): Promise<void> {
    if (this.failure) throw this.failure;
    this.puts.push(key);
    this.objects.set(key, body);
  }
  async get(key: string): Promise<Buffer> {
    const body = this.objects.get(key);
    if (!body) throw new Error("missing");
    return body;
  }
  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ key, size: body.length }));
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

describe("set ids", () => {
  it("formats the UTC instant to the second", () => {
    expect(formatSetId(Date.UTC(2026, 10, 9, 3, 4, 5, 678))).toBe("20261109T030405Z");
  });

  it("parses canonical ids only", () => {
    expect(parseSetId("20261109T030405Z")).toBe(Date.UTC(2026, 10, 9, 3, 4, 5));
    for (const bad of ["20261340T000000Z", "20261109T030405", "../20261109T030405Z", "x", ""]) {
      expect(parseSetId(bad)).toBeNull();
    }
  });
});

describe("reduceError", () => {
  it("keeps the first line and caps the length", () => {
    expect(reduceError(new Error("first line\nsecond line"))).toBe("first line");
    expect(reduceError("x".repeat(400))).toHaveLength(300);
    expect(reduceError(new Error(""))).toBe("Unknown error");
  });
});

describe("createBackup", () => {
  let t: KeyedTestDatabase;
  let workDir: string;
  let local: LocalDirStore;

  beforeEach(() => {
    t = createKeyedTestDatabase();
    seedBackupRows(t.sqlite, NOW);
    workDir = path.join(t.dir, "backups", ".work");
    local = new LocalDirStore(path.join(t.dir, "backups"));
  });
  afterEach(() => t.dispose());

  it("uploads an encrypted, verified copy and a manifest that describes it", async () => {
    const result = await createBackup({
      sqlite: t.sqlite,
      dbPassphrase: t.passphrase,
      workDir,
      stores: [local],
      now: () => NOW,
    });

    expect(result.setId).toBe("20261109T020000Z");
    const stored = await local.get(`20261109T020000Z/${DB_FILE}`);
    expect(stored.subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
    const migrations = (
      t.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }
    ).n;
    const expected: BackupManifest = {
      version: 1,
      setId: "20261109T020000Z",
      createdAt: "2026-11-09T02:00:00.345Z",
      schema: { migrations },
      files: [{ name: DB_FILE, size: stored.length, sha256: sha256Hex(stored) }],
    };
    expect(result.manifest).toEqual(expected);
    expect(result.sizeBytes).toBe(stored.length);
    const manifest = JSON.parse((await local.get(`20261109T020000Z/${MANIFEST_FILE}`)).toString());
    expect(manifest).toEqual(expected);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("produces a copy that opens with the database key and holds the rows", async () => {
    await createBackup({
      sqlite: t.sqlite,
      dbPassphrase: t.passphrase,
      workDir,
      stores: [local],
      now: () => NOW,
    });
    const copy = path.join(t.dir, "restored-copy.db");
    writeFileSync(copy, await local.get(`20261109T020000Z/${DB_FILE}`));
    const opened = openDatabase(copy, t.passphrase);
    try {
      const row = opened.sqlite.prepare("SELECT count(*) AS n FROM transactions").get();
      expect(row).toEqual({ n: 3 });
    } finally {
      opened.close();
    }
    expect(() => openDatabase(copy, "another-passphrase-0123456789")).toThrow(
      /file is not a database/,
    );
  });

  it("uploads the database before the manifest, to every store in order", async () => {
    const first = new RecordingStore("local");
    const second = new RecordingStore("s3");
    await createBackup({
      sqlite: t.sqlite,
      dbPassphrase: t.passphrase,
      workDir,
      stores: [first, second],
      now: () => NOW,
    });
    const keys = ["20261109T020000Z/bursar.db", "20261109T020000Z/manifest.json"];
    expect(first.puts).toEqual(keys);
    expect(second.puts).toEqual(keys);
  });

  it("keeps the local copy when a later store fails, then reports the failed store", async () => {
    const failing = new RecordingStore("s3", new Error("S3 put failed: HTTP 403 AccessDenied"));
    const error = await createBackup({
      sqlite: t.sqlite,
      dbPassphrase: t.passphrase,
      workDir,
      stores: [local, failing],
      now: () => NOW,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(BackupUploadError);
    expect(error.message).toBe("Upload failed for s3 (S3 put failed: HTTP 403 AccessDenied)");
    expect(error).toMatchObject({ setId: "20261109T020000Z" });
    expect(error.sizeBytes).toBeGreaterThan(0);
    expect(await listBackupSets(local)).toEqual(["20261109T020000Z"]);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("refuses to run inside a transaction", async () => {
    t.sqlite.exec("BEGIN");
    try {
      await expect(
        createBackup({
          sqlite: t.sqlite,
          dbPassphrase: t.passphrase,
          workDir,
          stores: [local],
          now: () => NOW,
        }),
      ).rejects.toThrow("Cannot back up from inside a transaction");
    } finally {
      t.sqlite.exec("ROLLBACK");
    }
  });

  it("fails without uploading when the copy does not open with the given passphrase", async () => {
    const store = new RecordingStore("local");
    await expect(
      createBackup({
        sqlite: t.sqlite,
        dbPassphrase: "not-the-database-passphrase-000",
        workDir,
        stores: [store],
        now: () => NOW,
      }),
    ).rejects.toThrow(/Cannot open encrypted database/);
    expect(store.puts).toEqual([]);
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("captures a row written just before the backup", async () => {
    t.sqlite
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('country', '\"IT\"', ?)")
      .run(NOW);
    await createBackup({
      sqlite: t.sqlite,
      dbPassphrase: t.passphrase,
      workDir,
      stores: [local],
      now: () => NOW,
    });
    const copy = path.join(t.dir, "check.db");
    writeFileSync(copy, await local.get(`20261109T020000Z/${DB_FILE}`));
    const opened = openDatabase(copy, t.passphrase);
    try {
      expect(
        opened.sqlite.prepare("SELECT value FROM settings WHERE key = 'country'").get(),
      ).toEqual({ value: '"IT"' });
    } finally {
      opened.close();
    }
  });
});

describe("listBackupSets", () => {
  it("returns complete sets newest first and ignores everything else", async () => {
    const store = new RecordingStore("local");
    const put = (key: string) => store.put(key, Buffer.from("x"));
    await put("20261107T020000Z/bursar.db");
    await put("20261107T020000Z/manifest.json");
    await put("20261109T020000Z/bursar.db");
    await put("20261109T020000Z/manifest.json");
    await put("20261108T020000Z/bursar.db"); // no manifest: incomplete
    await put("20261106T020000Z/manifest.json"); // no database: incomplete
    await put("notes/manifest.json");
    await put("20261105T020000Z/nested/bursar.db");
    expect(await listBackupSets(store)).toEqual(["20261109T020000Z", "20261107T020000Z"]);
  });
});
