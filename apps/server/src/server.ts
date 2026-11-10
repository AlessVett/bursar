import { once } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { Logger } from "pino";
import { AuditLog } from "./audit";
import { OwnerStore } from "./auth/owner";
import { FailureLimiter } from "./auth/rate-limit";
import { SessionStore } from "./auth/sessions";
import { SetupCode } from "./auth/setup-code";
import type { ObjectStore } from "./backup/object-store";
import { backupRoutes } from "./backup/routes";
import { S3Store } from "./backup/s3-store";
import { BackupService } from "./backup/service";
import { backupJobHandler, backupTask } from "./backup/task";
import { type Config, isLoopbackHost } from "./config";
import { deriveKey } from "./crypto";
import { type BursarDb, openDatabase, runMigrations, type Sqlite } from "./db";
import { AspspCache } from "./eb/aspsp-cache";
import { type EnableBankingApi, EnableBankingClient } from "./eb/client";
import { bankRoutes } from "./eb/routes";
import { EventBus } from "./events/bus";
import { bankCallbackRoutes } from "./finance/callback";
import { ConnectService } from "./finance/connect";
import { connectRoutes } from "./finance/connect-routes";
import { consentTask } from "./finance/consent-task";
import { syncHealthTask } from "./finance/health-task";
import { ConnectionLifecycle, deleteSessionJobHandler } from "./finance/lifecycle";
import { lifecycleRoutes } from "./finance/lifecycle-routes";
import { FinanceRepository } from "./finance/repository";
import { financeRoutes } from "./finance/routes";
import { syncAccountHandler, unconfiguredSyncHandler } from "./finance/sync";
import { syncRoutes } from "./finance/sync-routes";
import { dailySyncTask } from "./finance/sync-task";
import { createApp, type MountedRouter } from "./http/app";
import { createClientIpResolver } from "./http/client-ip";
import { eventsRoute } from "./http/events";
import { JobQueue } from "./jobs/queue";
import { BACKUP_JOB, DELETE_SESSION_JOB, EMAIL_JOB, SYNC_ACCOUNT_JOB } from "./jobs/types";
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
  /** Tests and the QA server inject a client (`FakeEnableBanking`); `null` disables banking. */
  bankingClient?: EnableBankingApi | null;
  /** `null` forces local-only backups; omit it to use `config.backup.s3`. Tests pass `null`. */
  backupS3?: ObjectStore | null;
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
  const ebConfig = config.enableBanking;
  const ebApi: EnableBankingApi | null =
    overrides.bankingClient !== undefined
      ? overrides.bankingClient
      : ebConfig
        ? new EnableBankingClient({
            applicationId: ebConfig.applicationId,
            privateKeyPem: ebConfig.privateKeyPem,
            // Config names it apiBaseUrl; the client option is baseUrl. Map it explicitly.
            baseUrl: ebConfig.apiBaseUrl,
          })
        : null;
  const lifecycle = new ConnectionLifecycle({ repo, api: ebApi, queue, bus, audit });
  handlers.set(DELETE_SESSION_JOB, deleteSessionJobHandler({ api: ebApi }));
  const aspsps = ebApi ? new AspspCache(ebApi) : null;
  const connect =
    ebApi && aspsps
      ? new ConnectService({
          repo,
          api: ebApi,
          aspsps,
          queue,
          bus,
          audit,
          settings,
          publicUrl: config.publicUrl,
          timezone: config.timezone,
        })
      : null;
  const notifications = new NotificationService({
    db: database.db,
    queue,
    bus,
    settings,
    emailEnabled: () => mailer !== null,
  });
  const backups = new BackupService({
    sqlite: database.sqlite,
    db: database.db,
    masterKey: config.masterKey,
    config: config.backup,
    s3:
      overrides.backupS3 !== undefined
        ? overrides.backupS3
        : config.backup.s3
          ? new S3Store(config.backup.s3)
          : null,
    notifications,
    bus,
    audit,
    timezone: config.timezone,
  });
  // Single process: a backup run still marked running was cut off by the previous process.
  const failedBackupRuns = backups.failStaleRuns();
  if (failedBackupRuns > 0) {
    logger.warn({ failedBackupRuns }, "Marked backup runs interrupted by a restart as failed");
  }
  if (backups.target() === "local") {
    logger.warn(
      { dir: config.backup.dir },
      "No S3 backup target: backups stay on this host only (set BACKUP_S3_*)",
    );
  }
  handlers.set(BACKUP_JOB, backupJobHandler(backups));
  bus.subscribe((event) => {
    if (event.type !== "backup.finished") return;
    const run = backups.status(1).runs[0];
    if (event.status === "succeeded") {
      logger.info(
        { setId: run?.setId, sizeBytes: run?.sizeBytes, target: run?.target },
        "Backup finished",
      );
    } else {
      logger.error(
        { setId: run?.setId, target: run?.target, error: run?.errorMessage },
        "Backup failed",
      );
    }
  });
  handlers.set(
    EMAIL_JOB,
    emailJobHandler({ service: notifications, mailer, settings, publicUrl: config.publicUrl }),
  );
  handlers.set(
    SYNC_ACCOUNT_JOB,
    ebApi
      ? syncAccountHandler({
          repo,
          api: ebApi,
          bus,
          notifications,
          settings,
          timezone: config.timezone,
          now: Date.now,
          logger,
        })
      : unconfiguredSyncHandler(),
  );
  const clientIp = createClientIpResolver(config.trustCfConnectingIp);
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
    {
      prefix: "/api/banks",
      router: bankRoutes({ api: ebApi, aspsps, publicUrl: config.publicUrl }),
    },
    { prefix: "/api/connections", router: connectRoutes({ service: connect }) },
    {
      prefix: "/api",
      router: syncRoutes({ repo, queue, clientIp, timezone: config.timezone }),
    },
    { prefix: "/api", router: lifecycleRoutes({ lifecycle }) },
    {
      prefix: "/api",
      router: financeRoutes({
        db: database.db,
        sqlite: database.sqlite,
        queue,
        timezone: config.timezone,
        now: Date.now,
        locale: () => settings.get().locale,
        audit,
        backup: () => {
          const status = backups.status(1);
          return { target: status.target, consecutiveFailures: status.consecutiveFailures };
        },
      }),
    },
    { prefix: "/api/backups", router: backupRoutes({ service: backups, queue }) },
  ];
  const publicRouters: MountedRouter[] = [
    { prefix: "/api/banks/callback", router: bankCallbackRoutes() },
  ];

  const loginLimiter = new FailureLimiter(5);
  const accountLimiter = new FailureLimiter(20);
  const worker = new JobWorker(queue, handlers, logger);
  const scheduler = new Scheduler(
    [
      maintenanceTask({
        queue,
        sessions,
        limiters: [loginLimiter, accountLimiter],
        logger,
        cleanups: [{ name: "auth-requests", run: () => repo.purgeExpiredAuthRequests() }],
      }),
      dailySyncTask({ repo, queue, settings, timezone: config.timezone, logger }),
      consentTask({
        repo,
        api: ebApi,
        notifications,
        bus,
        timezone: config.timezone,
        now: Date.now,
        logger,
      }),
      syncHealthTask({ repo, notifications, settings, timezone: config.timezone, now: Date.now }),
      backupTask({ queue, settings, db: database.db, timezone: config.timezone }),
    ],
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
      getClientIp: clientIp,
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
