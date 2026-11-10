import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pino } from "pino";
import { loadConfig } from "../config";
import { configSecrets, createLogger } from "../logger";
import { startBursar } from "../server";
import { seedQa } from "./seed";

/**
 * Ephemeral, seeded Bursar for the QA harness: loopback only, a temporary data directory that is
 * removed on exit, and a fixed master key. The key is not a secret: QA databases are throwaway.
 *
 * Usage (from apps/server): tsx --tsconfig tsconfig.runtime.json src/qa/qa-server.ts
 *   [--no-owner] [--web-dist <path>]
 * Prints exactly one JSON line on stdout once it listens:
 *   {"ready":true,"baseUrl":"http://127.0.0.1:<port>","sessionToken":"<token or null>"}
 * Logs go to stderr. Stops on SIGTERM, SIGINT or when stdin closes (the harness exited).
 */
const QA_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const SERVER_DIR = path.resolve(import.meta.dirname, "../..");

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("No free port found"))));
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "no-owner": { type: "boolean", default: false },
      "web-dist": { type: "string" },
    },
  });
  const webDist = path.resolve(values["web-dist"] ?? path.join(SERVER_DIR, "../web/dist"));
  const port = await freeLoopbackPort();
  const dataDir = mkdtempSync(path.join(tmpdir(), "bursar-qa-"));
  const removeDataDir = () => rmSync(dataDir, { recursive: true, force: true });

  let sessionToken: string | null = null;
  const running = await (async () => {
    const config = loadConfig({
      BURSAR_PUBLIC_URL: `http://127.0.0.1:${port}`,
      BURSAR_HOST: "127.0.0.1",
      BURSAR_PORT: String(port),
      TZ: "Europe/Rome",
      BURSAR_MASTER_KEY: QA_MASTER_KEY,
      BURSAR_DATA_DIR: dataDir,
      BURSAR_MIGRATIONS_DIR: path.join(SERVER_DIR, "drizzle"),
      BURSAR_WEB_DIST: webDist,
      BURSAR_LOG_LEVEL: "warn",
    });
    const logger = createLogger(
      config.logLevel,
      pino.destination({ dest: 2, sync: true }),
      configSecrets(config),
    );
    return startBursar(config, logger, {
      seed: async (ctx) => {
        sessionToken = (await seedQa(ctx, { owner: values["no-owner"] !== true })).sessionToken;
      },
    });
  })().catch((error: unknown) => {
    removeDataDir();
    throw error;
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    running.close().finally(() => {
      removeDataDir();
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.resume();

  process.stdout.write(
    `${JSON.stringify({ ready: true, baseUrl: `http://127.0.0.1:${running.port}`, sessionToken })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `QA server failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
