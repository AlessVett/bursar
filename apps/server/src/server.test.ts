import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { SetupStartResponse } from "@bursar/shared";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateTotpCode } from "./auth/totp";
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

  /** Runs owner setup over HTTP and returns the Set-Cookie header of the confirmation. */
  async function completeSetup(base: string, origin: string): Promise<string> {
    const post = (route: string, body: unknown) =>
      fetch(`${base}${route}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const setupCode = readFileSync(path.join(dir, "setup-code"), "utf8").trim();
    const start = await post("/api/auth/setup/start", {
      setupCode,
      password: "correct horse battery staple",
    });
    expect(start.status).toBe(200);
    const { setupToken, secret } = (await start.json()) as SetupStartResponse;
    const confirm = await post("/api/auth/setup/confirm", {
      setupToken,
      code: generateTotpCode(secret, Date.now()),
    });
    expect(confirm.status).toBe(200);
    return confirm.headers.get("set-cookie") ?? "";
  }

  it("marks the session cookie Secure when the public URL is HTTPS", async () => {
    const { base, origin } = await boot({ BURSAR_PUBLIC_URL: "https://bursar.example.test" });
    const setCookie = await completeSetup(base, origin);
    expect(setCookie).toMatch(/^bursar_session=/);
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("omits Secure on a plain-HTTP loopback public URL", async () => {
    const { base, origin } = await boot({ BURSAR_PUBLIC_URL: "http://127.0.0.1" });
    const setCookie = await completeSetup(base, origin);
    expect(setCookie).toMatch(/^bursar_session=/);
    expect(setCookie).not.toMatch(/;\s*Secure/i);
  });

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

  it("limits a client that rotates addresses inside one IPv6 /64", async () => {
    const { base, origin } = await boot({ BURSAR_TRUST_CF_CONNECTING_IP: "true" });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await wrongLogin(base, origin, `2001:db8::${i}`)).status);
    }
    expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
