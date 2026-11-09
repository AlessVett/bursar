import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { startBursar } from "./server";
import { MIGRATIONS_DIR } from "./test/db";

describe("startBursar", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-boot-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("boots, serves health and auth status, issues a setup code and shuts down", async () => {
    const config = loadConfig({
      BURSAR_PUBLIC_URL: "http://127.0.0.1",
      TZ: "UTC",
      BURSAR_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
      BURSAR_DATA_DIR: dir,
      BURSAR_MIGRATIONS_DIR: MIGRATIONS_DIR,
    });
    const running = await startBursar({ ...config, port: 0 }, pino({ level: "silent" }));
    try {
      const base = `http://127.0.0.1:${running.port}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect(await (await fetch(`${base}/api/auth/status`)).json()).toEqual({
        setupRequired: true,
        authenticated: false,
      });
      expect(existsSync(path.join(dir, "setup-code"))).toBe(true);
      expect(existsSync(path.join(dir, "bursar.db"))).toBe(true);
    } finally {
      await running.close();
    }
  });
});
