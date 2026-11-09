import { ConfigError, loadConfig } from "./config";
import { configSecrets, createLogger } from "./logger";
import { startBursar } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, undefined, configSecrets(config));
  const running = await startBursar(config, logger);
  logger.info({ host: config.host, port: running.port }, "Bursar is listening");

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ error: String(error) }, "Shutdown failed");
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(78);
  }
  console.error(error);
  process.exit(1);
});
