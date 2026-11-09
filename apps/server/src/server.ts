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
import type { Config } from "./config";
import { deriveKey } from "./crypto";
import { openDatabase, runMigrations } from "./db";
import { createApp } from "./http/app";
import { JobQueue } from "./jobs/queue";
import { type JobHandler, JobWorker } from "./jobs/worker";
import { maintenanceTask } from "./maintenance";
import { Scheduler } from "./scheduler";

export interface RunningBursar {
  port: number;
  close(): Promise<void>;
}

export async function startBursar(config: Config, logger: Logger): Promise<RunningBursar> {
  mkdirSync(config.dataDir, { recursive: true });
  const database = openDatabase(
    path.join(config.dataDir, "bursar.db"),
    deriveKey(config.masterKey, "database").toString("hex"),
  );
  runMigrations(database.db, config.migrationsDir);

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
      limiter: new FailureLimiter(),
      secureCookies: config.publicUrl.protocol === "https:",
      now: Date.now,
      getClientIp: (c) =>
        (config.cfAccess ? c.req.header("cf-connecting-ip") : undefined) ??
        getConnInfo(c).remote.address ??
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
