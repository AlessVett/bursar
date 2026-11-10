import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AuditLog } from "./audit";
import { listBackupSets } from "./backup/backup";
import { LocalDirStore, type ObjectStore } from "./backup/object-store";
import { RestoreError, restoreBackup } from "./backup/restore";
import { S3Store } from "./backup/s3-store";
import { BackupService } from "./backup/service";
import { type Config, ConfigError, loadConfig } from "./config";
import { deriveKey, generateMasterKey } from "./crypto";
import { openDatabase, runMigrations } from "./db";
import { EventBus } from "./events/bus";
import { JobQueue } from "./jobs/queue";
import { NotificationService } from "./notifications/service";
import { SettingsStore } from "./settings/store";

const INIT_USAGE = "Usage: bursar init --out <path>";

export const USAGE = [
  "Usage:",
  "  bursar init --out <path>",
  "  bursar backup run",
  "  bursar backup list [--remote]",
  "  bursar restore --set <setId> --to <dir> [--from local|s3] [--force]",
].join("\n");

/** Exit code for a configuration problem, as in `index.ts`. */
export const EXIT_CONFIG = 78;

export function initCommand(args: string[], log: (line: string) => void = console.log): number {
  const index = args.indexOf("--out");
  const target = index >= 0 ? args[index + 1] : undefined;
  if (!target) {
    log(INIT_USAGE);
    return 2;
  }
  try {
    writeFileSync(target, `${generateMasterKey()}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      log(`Refusing to overwrite an existing file: ${target}`);
      return 1;
    }
    throw error;
  }
  log(`Master key written to ${target} (mode 600).`);
  log("Keep an offline copy of this file: without it the data cannot be decrypted.");
  return 0;
}

/** Where commands read their environment and write their output; tests replace all three. */
export interface CliContext {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  error: (line: string) => void;
}

function context(partial: Partial<CliContext>): CliContext {
  return {
    env: partial.env ?? process.env,
    log: partial.log ?? ((line) => console.log(line)),
    error: partial.error ?? ((line) => console.error(line)),
  };
}

/** The configuration, or null after printing every problem (names only, never values). */
function configOrNull(ctx: CliContext): Config | null {
  try {
    return loadConfig(ctx.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    for (const problem of error.problems) ctx.error(problem);
    return null;
  }
}

function s3StoreOf(config: Config): S3Store | null {
  return config.backup.s3 ? new S3Store(config.backup.s3) : null;
}

/** `bursar backup run` and `bursar backup list [--remote]`. */
export async function backupCommand(
  args: string[],
  partial: Partial<CliContext> = {},
): Promise<number> {
  const ctx = context(partial);
  const [subcommand, ...rest] = args;
  if (subcommand === "run" && rest.length === 0) return backupRun(ctx);
  if (
    subcommand === "list" &&
    (rest.length === 0 || (rest.length === 1 && rest[0] === "--remote"))
  ) {
    return backupList(ctx, rest[0] === "--remote");
  }
  ctx.error(USAGE);
  return 2;
}

async function backupRun(ctx: CliContext): Promise<number> {
  const config = configOrNull(ctx);
  if (!config) return EXIT_CONFIG;
  const file = path.join(config.dataDir, "bursar.db");
  if (!existsSync(file)) {
    ctx.error(`No database at ${file}`);
    return 1;
  }
  // WAL lets this run next to a running server; a run in the server's own process is not
  // visible here, and two runs in the same second write the same set id.
  const database = openDatabase(file, deriveKey(config.masterKey, "database").toString("hex"));
  try {
    runMigrations(database.db, config.migrationsDir);
    const queue = new JobQueue(database.sqlite);
    const bus = new EventBus();
    const settings = new SettingsStore(database.db);
    const service = new BackupService({
      sqlite: database.sqlite,
      db: database.db,
      masterKey: config.masterKey,
      config: config.backup,
      s3: s3StoreOf(config),
      // A `backup_failing` email raised here is queued and sent by the running server.
      notifications: new NotificationService({
        db: database.db,
        queue,
        bus,
        settings,
        emailEnabled: () => config.smtp !== null,
      }),
      bus,
      audit: new AuditLog(database.db),
      timezone: config.timezone,
    });
    const run = await service.run("cli");
    if (run.status !== "succeeded") {
      ctx.error(`Backup failed: ${run.errorMessage ?? "unknown error"}`);
      return 1;
    }
    ctx.log(JSON.stringify({ setId: run.setId, sizeBytes: run.sizeBytes, target: run.target }));
    return 0;
  } finally {
    database.close();
  }
}

async function backupList(ctx: CliContext, remote: boolean): Promise<number> {
  const config = configOrNull(ctx);
  if (!config) return EXIT_CONFIG;
  const store: ObjectStore | null = remote
    ? s3StoreOf(config)
    : new LocalDirStore(config.backup.dir);
  if (!store) {
    ctx.error("No S3 backup target is configured (BACKUP_S3_*)");
    return 1;
  }
  for (const setId of await listBackupSets(store)) ctx.log(setId);
  return 0;
}

/** `bursar restore --set <setId> --to <dir> [--from local|s3] [--force]`. */
export async function restoreCommand(
  args: string[],
  partial: Partial<CliContext> = {},
): Promise<number> {
  const ctx = context(partial);
  let setId: string | undefined;
  let to: string | undefined;
  let from = "local";
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force") force = true;
    else if (arg === "--set" || arg === "--to" || arg === "--from") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) {
        ctx.error(USAGE);
        return 2;
      }
      if (arg === "--set") setId = value;
      else if (arg === "--to") to = value;
      else from = value;
    } else {
      ctx.error(USAGE);
      return 2;
    }
  }
  if (!setId || !to || (from !== "local" && from !== "s3")) {
    ctx.error(USAGE);
    return 2;
  }

  const config = configOrNull(ctx);
  if (!config) return EXIT_CONFIG;
  const source: ObjectStore | null =
    from === "s3" ? s3StoreOf(config) : new LocalDirStore(config.backup.dir);
  if (!source) {
    ctx.error("No S3 backup target is configured (BACKUP_S3_*)");
    return 1;
  }
  try {
    const result = await restoreBackup({
      source,
      setId,
      targetDir: path.resolve(to),
      masterKey: config.masterKey,
      force,
    });
    ctx.log(JSON.stringify({ restored: result.setId, tables: result.tables }));
    return 0;
  } catch (error) {
    if (error instanceof RestoreError) {
      ctx.error(`Restore failed (${error.code}): ${error.message}`);
      return 1;
    }
    ctx.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Dispatches `bursar <command> …`; returns the exit code. */
export async function runCli(argv: string[], partial: Partial<CliContext> = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "init") return initCommand(rest, partial.log);
  if (command === "backup") return backupCommand(rest, partial);
  if (command === "restore") return restoreCommand(rest, partial);
  context(partial).error(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
