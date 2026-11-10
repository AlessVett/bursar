import { once } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Logger } from "pino";
import { AuditLog } from "./audit";
import { OwnerStore } from "./auth/owner";
import { FailureLimiter } from "./auth/rate-limit";
import { SessionStore } from "./auth/sessions";
import { SetupCode } from "./auth/setup-code";
import { type Config, isLoopbackHost } from "./config";
import { deriveKey } from "./crypto";
import { type BursarDb, openDatabase, runMigrations, type Sqlite } from "./db";
import { EventBus } from "./events/bus";
import { FinanceRepository } from "./finance/repository";
import { createApp, type MountedRouter } from "./http/app";
import { eventsRoute } from "./http/events";
import { JobQueue } from "./jobs/queue";
import { EMAIL_JOB } from "./jobs/types";
import { type JobHandler, JobWorker } from "./jobs/worker";
import { maintenanceTask } from "./maintenance";
import { emailJobHandler } from "./notifications/email-job";
import { createSmtpMailer, type Mailer } from "./notifications/mailer";
import { notificationRoutes } from "./notifications/routes";
import { NotificationService } from "./notifications/service";
import { Scheduler } from "./scheduler";
import { settingsRoutes } from "./settings/routes";
import { SettingsStore } from "./settings/store";

export interface RunningBursar {
  port: number;
  /** Raises panel notifications (and their emails); used by later tasks and tests. */
  notifications: NotificationService;
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
 * (for example a fake Enable Banking client).
 */
export interface StartOverrides {
  /** Runs once after the migrations, before the owner check, the worker, the scheduler and the listener. */
  seed?: (ctx: SeedContext) => void | Promise<void>;
  /** `null` forces "no SMTP"; omit it to use `config.smtp`. Tests and the QA server pass a `MemoryMailer`. */
  mailer?: Mailer | null;
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

  const bus = new EventBus((error) =>
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Event listener failed",
    ),
  );
  const repo = new FinanceRepository(database.db);
  const audit = new AuditLog(database.db);
  const settings = new SettingsStore(database.db);
  const queue = new JobQueue(database.sqlite, Date.now, (job) =>
    logger.error({ jobId: job.id, type: job.type }, "Job payload is not valid JSON; failed"),
  );

  // Single process: whatever is still marked running was orphaned by the previous process, so it
  // is recovered now rather than after the 10 minute maintenance threshold. This must run before
  // the worker starts.
  const requeuedJobs = queue.recoverStale(0);
  const failedSyncRuns = repo.failStaleSyncRuns("Interrupted by a restart");
  if (requeuedJobs > 0 || failedSyncRuns > 0) {
    logger.warn({ requeuedJobs, failedSyncRuns }, "Recovered work interrupted by a restart");
  }

  // Later tasks register their job handlers and routers here, before the worker and app start.
  const handlers = new Map<string, JobHandler>();
  const mailer: Mailer | null =
    overrides.mailer !== undefined
      ? overrides.mailer
      : config.smtp
        ? createSmtpMailer(config.smtp)
        : null;
  const notifications = new NotificationService({
    db: database.db,
    queue,
    bus,
    settings,
    emailEnabled: () => mailer !== null,
  });
  handlers.set(
    EMAIL_JOB,
    emailJobHandler({ service: notifications, mailer, settings, publicUrl: config.publicUrl }),
  );
  const shutdown = new AbortController();
  const routers: MountedRouter[] = [
    { prefix: "/api/events", router: eventsRoute({ bus, sessions, signal: shutdown.signal }) },
    {
      prefix: "/api/settings",
      router: settingsRoutes({
        store: settings,
        audit,
        bus,
        system: {
          timezone: config.timezone,
          publicUrl: config.publicUrl.origin,
          enableBankingConfigured: config.enableBanking !== null,
          smtpConfigured: config.smtp !== null,
          backupTarget: config.backup.s3 ? "s3" : "local",
        },
      }),
    },
    {
      prefix: "/api/notifications",
      router: notificationRoutes({
        service: notifications,
        mailer,
        settings,
        publicUrl: config.publicUrl,
      }),
    },
  ];
  const publicRouters: MountedRouter[] = [];

  const loginLimiter = new FailureLimiter(5);
  const accountLimiter = new FailureLimiter(20);
  const worker = new JobWorker(queue, handlers, logger);
  const scheduler = new Scheduler(
    [maintenanceTask({ queue, sessions, limiters: [loginLimiter, accountLimiter], logger })],
    logger,
  );

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
      limiter: loginLimiter,
      accountLimiter,
      secureCookies: config.publicUrl.protocol === "https:",
      now: Date.now,
      // CF-Connecting-IP is set by Cloudflare's edge; any other client could forge it.
      getClientIp: (c) =>
        (config.trustCfConnectingIp ? c.req.header("cf-connecting-ip")?.trim() : undefined) ||
        getConnInfo(c).remote.address ||
        "unknown",
    },
    routers,
    publicRouters,
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  worker.start();
  scheduler.start();

  return {
    port,
    notifications,
    close: async () => {
      // Open event streams would keep server.close() waiting for the panel to disconnect.
      shutdown.abort();
      await scheduler.stop();
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}
