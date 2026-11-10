import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand, runCli, USAGE } from "./cli";
import { openDatabase, runMigrations } from "./db";
import { databasePassphrase, seedBackupRows } from "./test/backup";
import { MIGRATIONS_DIR } from "./test/db";

describe("bursar init", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a 32-byte base64 key to a private file without printing it", () => {
    const file = path.join(dir, "master_key");
    const printed: string[] = [];
    expect(initCommand(["--out", file], (line) => printed.push(line))).toBe(0);
    const key = readFileSync(file, "utf8").trim();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(printed.join("\n")).not.toContain(key);
  });

  it("refuses to overwrite an existing key", () => {
    const file = path.join(dir, "master_key");
    initCommand(["--out", file], () => {});
    expect(initCommand(["--out", file], () => {})).toBe(1);
  });

  it("requires --out", () => {
    expect(initCommand([], () => {})).toBe(2);
  });
});

describe("bursar backup and restore", () => {
  const masterKey = Buffer.alloc(32, 5);
  let dir: string;
  let dataDir: string;
  let out: string[];
  let err: string[];

  const env = (extra: Record<string, string> = {}) => ({
    BURSAR_PUBLIC_URL: "http://127.0.0.1:8080",
    TZ: "Europe/Rome",
    BURSAR_MASTER_KEY: masterKey.toString("base64"),
    BURSAR_DATA_DIR: dataDir,
    BURSAR_MIGRATIONS_DIR: MIGRATIONS_DIR,
    ...extra,
  });
  const cli = (argv: string[], extra: Record<string, string> = {}) =>
    runCli(argv, {
      env: env(extra),
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-cli-backup-"));
    dataDir = path.join(dir, "data");
    mkdirSync(dataDir);
    out = [];
    err = [];
    const database = openDatabase(path.join(dataDir, "bursar.db"), databasePassphrase(masterKey));
    runMigrations(database.db, MIGRATIONS_DIR);
    seedBackupRows(database.sqlite, Date.now());
    database.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function runBackup(): Promise<string> {
    expect(await cli(["backup", "run"])).toBe(0);
    const printed = JSON.parse(out.at(-1) ?? "{}") as {
      setId: string;
      sizeBytes: number;
      target: string;
    };
    expect(printed.setId).toMatch(/^\d{8}T\d{6}Z$/);
    expect(printed.sizeBytes).toBeGreaterThan(0);
    expect(printed.target).toBe("local");
    return printed.setId;
  }

  it("backs up into <dataDir>/backups and lists the set", async () => {
    const setId = await runBackup();
    const file = path.join(dataDir, "backups", setId, "bursar.db");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(dataDir, "backups", setId, "manifest.json"))).toBe(true);

    out = [];
    expect(await cli(["backup", "list"])).toBe(0);
    expect(out).toEqual([setId]);
    expect(err).toEqual([]);
  });

  it("restores a set into an empty directory and refuses to overwrite it without --force", async () => {
    const setId = await runBackup();
    const target = path.join(dir, "restored");

    out = [];
    expect(await cli(["restore", "--set", setId, "--to", target])).toBe(0);
    const printed = JSON.parse(out[0] ?? "{}") as {
      restored: string;
      tables: Record<string, number>;
    };
    expect(printed.restored).toBe(setId);
    expect(printed.tables).toMatchObject({ transactions: 3, accounts: 1, settings: 1 });
    const restored = openDatabase(path.join(target, "bursar.db"), databasePassphrase(masterKey));
    expect(restored.sqlite.prepare("SELECT count(*) AS n FROM transactions").get()).toEqual({
      n: 3,
    });
    restored.close();

    expect(await cli(["restore", "--set", setId, "--to", target])).toBe(1);
    expect(err.at(-1)).toMatch(/^Restore failed \(target_not_empty\): /);
    expect(
      await cli(["restore", "--set", setId, "--to", target, "--from", "local", "--force"]),
    ).toBe(0);
  });

  it("reports the restore error code for an unknown set and a wrong master key", async () => {
    const setId = await runBackup();
    expect(await cli(["restore", "--set", "20991231T000000Z", "--to", path.join(dir, "a")])).toBe(
      1,
    );
    expect(err.at(-1)).toMatch(/^Restore failed \(set_not_found\): /);
    const otherKey = Buffer.alloc(32, 6).toString("base64");
    expect(
      await cli(["restore", "--set", setId, "--to", path.join(dir, "b")], {
        BURSAR_MASTER_KEY: otherKey,
      }),
    ).toBe(1);
    expect(err.at(-1)).toMatch(/^Restore failed \(wrong_key\): /);
    expect(err.join("\n")).not.toContain(masterKey.toString("base64"));
  });

  it("explains a missing S3 target, a missing database and a bad configuration", async () => {
    expect(await cli(["backup", "list", "--remote"])).toBe(1);
    expect(err.at(-1)).toBe("No S3 backup target is configured (BACKUP_S3_*)");
    expect(await cli(["restore", "--set", "20261109T020000Z", "--to", dir, "--from", "s3"])).toBe(
      1,
    );

    rmSync(path.join(dataDir, "bursar.db"));
    expect(await cli(["backup", "run"])).toBe(1);
    expect(err.at(-1)).toMatch(/^No database at /);

    const exit = await runCli(["backup", "list"], {
      env: { TZ: "Europe/Rome" },
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    expect(exit).toBe(78);
  });

  it.each([
    [["backup"]],
    [["backup", "prune"]],
    [["backup", "list", "--all"]],
    [["restore", "--set", "20261109T020000Z"]],
    [["restore", "--to", "/tmp/x"]],
    [["restore", "--set", "20261109T020000Z", "--to", "/tmp/x", "--from", "ftp"]],
    [["restore", "--set", "--to", "/tmp/x"]],
    [["unknown"]],
  ])("prints the usage and exits 2 for %j", async (argv) => {
    expect(await cli(argv)).toBe(2);
    expect(err.at(-1)).toBe(USAGE);
  });

  it("still dispatches init", async () => {
    const file = path.join(dir, "master_key");
    expect(await cli(["init", "--out", file])).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});
