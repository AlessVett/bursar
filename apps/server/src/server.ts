import { once } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Logger } from "pino";
import { OwnerStore } from "./auth/owner";
import { FailureLimiter } from "./auth/rate-limit";
import { SessionStore } from "./auth/sessions";
import { SetupCode } from "./auth/setup-code";
import { type Config, isLoopbackHost } from "./config";
import { deriveKey } from "./crypto";
import { type BursarDb, openDatabase, runMigrations, type Sqlite } from "./db";
import { createApp } from "./http/app";
import { JobQueue } from "./jobs/queue";
import { type JobHandler, JobWorker } from "./jobs/worker";
import { maintenanceTask } from "./maintenance";
import { Scheduler } from "./scheduler";

export interface RunningBursar {
  port: number;
  close(): Promise<void>;
}

/** What a seed hook receives: the migrated database, the configuration and the clock. */
export interface SeedContext {
  db: BursarDb;
  sqlite: Sqlite;
  config: Config;
  now: () => number;
}

/**
 * Test and QA hooks into startup. Production (`index.ts`) passes none. Later tasks add fields
 * (for example a fake Enable Banking client or a mailer).
 */
export interface StartOverrides {
  /** Runs once after the migrations, before the owner check, the worker, the scheduler and the listener. */
  seed?: (ctx: SeedContext) => void | Promise<void>;
}

export async function startBursar(
  config: Config,
  logger: Logger,
  overrides: StartOverrides = {},
): Promise<RunningBursar> {
  if (!config.cfAccess && !isLoopbackHost(config.publicUrl.hostname)) {
    logger.warn(
      { publicUrl: config.publicUrl.origin },
      "Cloudflare Access is not configured: the panel is protected by the app login alone",
    );
  }
  mkdirSync(config.dataDir, { recursive: true });
  const database = openDatabase(
    path.join(config.dataDir, "bursar.db"),
    deriveKey(config.masterKey, "database").toString("hex"),
  );
  runMigrations(database.db, config.migrationsDir);

  if (overrides.seed) {
    try {
      await overrides.seed({ db: database.db, sqlite: database.sqlite, config, now: Date.now });
    } catch (error) {
      database.close();
      throw error;
    }
  }

  const owners = new OwnerStore(database.db, deriveKey(config.masterKey, "totp"));
  const sessions = new SessionStore(database.db);
  const setupCodeFile = path.join(config.dataDir, "setup-code");
  const setupCode = new SetupCode(setupCodeFile);
  if (!owners.exists()) {
    setupCode.issue();
    logger.warn({ file: setupCodeFile }, "No owner yet: open the panel and enter the setup code");
  }

  const queue = new JobQueue(database.sqlite);
  const worker = new JobWorker(queue, new Map<string, JobHandler>(), logger);
  const scheduler = new Scheduler([maintenanceTask(queue, sessions, logger)], logger);

  const app = createApp({
    config,
    logger,
    healthCheck: () => {
      try {
        database.sqlite.prepare("SELECT 1").get();
        return true;
      } catch {
        return false;
      }
    },
    auth: {
      owners,
      sessions,
      setupCode,
      // 5 failures per client and 20 for the account per 15 minutes; sessions stay valid.
      limiter: new FailureLimiter(5),
      accountLimiter: new FailureLimiter(20),
      secureCookies: config.publicUrl.protocol === "https:",
      now: Date.now,
      // CF-Connecting-IP is set by Cloudflare's edge; any other client could forge it.
      getClientIp: (c) =>
        (config.trustCfConnectingIp ? c.req.header("cf-connecting-ip")?.trim() : undefined) ||
        getConnInfo(c).remote.address ||
        "unknown",
    },
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  worker.start();
  scheduler.start();

  return {
    port,
    close: async () => {
      await scheduler.stop();
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}
