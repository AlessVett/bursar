import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { type RunningBursar, startBursar } from "./server";
import { MIGRATIONS_DIR } from "./test/db";

describe("startBursar", () => {
  let dir: string;
  let running: RunningBursar[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-boot-"));
    running = [];
  });
  afterEach(async () => {
    for (const instance of running) await instance.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(env: Record<string, string> = {}, logLines?: string[]) {
    const config = loadConfig({
      BURSAR_PUBLIC_URL: "http://127.0.0.1",
      TZ: "UTC",
      BURSAR_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
      BURSAR_DATA_DIR: dir,
      BURSAR_MIGRATIONS_DIR: MIGRATIONS_DIR,
      ...env,
    });
    const logger = logLines
      ? pino(
          { level: "info" },
          new Writable({
            write(chunk, _encoding, callback) {
              logLines.push(chunk.toString());
              callback();
            },
          }),
        )
      : pino({ level: "silent" });
    const instance = await startBursar({ ...config, port: 0 }, logger);
    running.push(instance);
    return { base: `http://127.0.0.1:${instance.port}`, origin: config.publicUrl.origin };
  }

  const wrongLogin = (base: string, origin: string, clientIp?: string) =>
    fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(clientIp ? { "cf-connecting-ip": clientIp } : {}),
      },
      body: JSON.stringify({ password: "wrong password", code: "000000" }),
    });

  const accessWarnings = (lines: string[]) =>
    lines.filter((line) => line.includes("Cloudflare Access is not configured"));

  it("boots, serves health and auth status, issues a setup code and shuts down", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/auth/status`)).json()).toEqual({
      setupRequired: true,
      authenticated: false,
    });
    expect(existsSync(path.join(dir, "setup-code"))).toBe(true);
    expect(existsSync(path.join(dir, "bursar.db"))).toBe(true);
  });

  it("warns when a public URL is served without Cloudflare Access", async () => {
    const lines: string[] = [];
    await boot({ BURSAR_PUBLIC_URL: "https://bursar.example.test" }, lines);
    const warnings = accessWarnings(lines);
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0] as string)).toMatchObject({ level: 40 });
  });

  it("does not warn on a loopback URL or when Cloudflare Access is configured", async () => {
    const lines: string[] = [];
    await boot({}, lines);
    await boot(
      {
        BURSAR_PUBLIC_URL: "https://bursar.example.test",
        CF_ACCESS_TEAM_DOMAIN: "team.example.test",
        CF_ACCESS_AUD: "aud",
      },
      lines,
    );
    expect(accessWarnings(lines)).toHaveLength(0);
  });

  it("ignores CF-Connecting-IP by default, so rotating it cannot dodge the login limit", async () => {
    const { base, origin } = await boot();
    for (let i = 0; i < 5; i += 1) {
      expect((await wrongLogin(base, origin, `198.51.100.${i}`)).status).not.toBe(429);
    }
    expect((await wrongLogin(base, origin, "198.51.100.99")).status).toBe(429);
  });

  it("keys the login limit on CF-Connecting-IP when it is trusted", async () => {
    const { base, origin } = await boot({ BURSAR_TRUST_CF_CONNECTING_IP: "true" });
    for (let i = 0; i < 6; i += 1) {
      expect((await wrongLogin(base, origin, `198.51.100.${i}`)).status).not.toBe(429);
    }
    for (let i = 0; i < 5; i += 1) await wrongLogin(base, origin, "198.51.100.200");
    expect((await wrongLogin(base, origin, "198.51.100.200")).status).toBe(429);
  });
});
