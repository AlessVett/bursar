import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { SetupStartResponse } from "@bursar/shared";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateTotpCode } from "./auth/totp";
import { loadConfig } from "./config";
import { deriveKey } from "./crypto";
import { type OpenedDatabase, openDatabase, runMigrations } from "./db";
import { JobQueue } from "./jobs/queue";
import { seedQa } from "./qa/seed";
import { type RunningBursar, type SeedContext, type StartOverrides, startBursar } from "./server";
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

  async function boot(
    env: Record<string, string> = {},
    logLines?: string[],
    overrides?: StartOverrides,
  ) {
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
    const instance = await startBursar({ ...config, port: 0 }, logger, overrides);
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

  it("runs the seed hook once before the owner check, so a seeded owner gets no setup code", async () => {
    const calls: SeedContext[] = [];
    let token: string | null = null;
    const { base } = await boot({}, undefined, {
      seed: async (ctx) => {
        calls.push(ctx);
        token = (await seedQa(ctx, { owner: true })).sessionToken;
      },
    });
    expect(calls).toHaveLength(1);
    expect(existsSync(path.join(dir, "setup-code"))).toBe(false);
    const status = await fetch(`${base}/api/auth/status`, {
      headers: { cookie: `bursar_session=${token}` },
    });
    expect(await status.json()).toEqual({ setupRequired: false, authenticated: true });
  });

  it("rejects and starts nothing when the seed hook throws", async () => {
    await expect(
      boot({}, undefined, {
        seed: () => {
          throw new Error("seed failed");
        },
      }),
    ).rejects.toThrow("seed failed");
    expect(running).toHaveLength(0);
  });
});

describe("startBursar startup recovery and live events", () => {
  let dir: string;
  let running: RunningBursar[];
  let masterKey: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-recover-"));
    running = [];
    masterKey = Buffer.alloc(32, 3).toString("base64");
  });
  afterEach(async () => {
    for (const instance of running) await instance.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = () =>
    loadConfig({
      BURSAR_PUBLIC_URL: "http://127.0.0.1",
      TZ: "UTC",
      BURSAR_MASTER_KEY: masterKey,
      BURSAR_DATA_DIR: dir,
      BURSAR_MIGRATIONS_DIR: MIGRATIONS_DIR,
    });

  /** Opens the data directory's database the way the server does, to prepare or inspect it. */
  function withDatabase<T>(fn: (database: OpenedDatabase) => T): T {
    const database = openDatabase(
      path.join(dir, "bursar.db"),
      deriveKey(config().masterKey, "database").toString("hex"),
    );
    try {
      runMigrations(database.db, MIGRATIONS_DIR);
      return fn(database);
    } finally {
      database.close();
    }
  }

  async function boot(logLines: string[] = []) {
    const logger = pino(
      { level: "info" },
      new Writable({
        write(chunk, _encoding, callback) {
          logLines.push(chunk.toString());
          callback();
        },
      }),
    );
    const instance = await startBursar({ ...config(), port: 0 }, logger);
    running.push(instance);
    return { base: `http://127.0.0.1:${instance.port}`, origin: "http://127.0.0.1" };
  }

  async function signIn(base: string, origin: string): Promise<string> {
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
    const { setupToken, secret } = (await start.json()) as SetupStartResponse;
    const confirm = await post("/api/auth/setup/confirm", {
      setupToken,
      code: generateTotpCode(secret, Date.now()),
    });
    expect(confirm.status).toBe(200);
    return (confirm.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  it("requeues running jobs and fails running sync runs left by the previous process", async () => {
    const syncRunId = withDatabase(({ sqlite }) => {
      const queue = new JobQueue(sqlite);
      const jobId = queue.enqueue("test.never-registered", {});
      expect(queue.claimNext()?.id).toBe(jobId);
      const ts = Date.now();
      const connection = sqlite
        .prepare(
          `INSERT INTO bank_connections (aspsp_name, aspsp_country, provider_session_id, valid_until, created_at, updated_at)
           VALUES ('Banca Esempio', 'IT', 'session-fixture', ?, ?, ?)`,
        )
        .run(ts + 86_400_000, ts, ts);
      const account = sqlite
        .prepare(
          `INSERT INTO accounts (connection_id, identification_hash, currency, created_at, updated_at)
           VALUES (?, 'hash-fixture', 'EUR', ?, ?)`,
        )
        .run(connection.lastInsertRowid, ts, ts);
      const run = sqlite
        .prepare(
          `INSERT INTO sync_runs (account_id, trigger, status, started_at) VALUES (?, 'manual', 'running', ?)`,
        )
        .run(account.lastInsertRowid, ts);
      return Number(run.lastInsertRowid);
    });

    const lines: string[] = [];
    await boot(lines);

    const recovery = lines
      .map((line) => JSON.parse(line))
      .find((l) => l.msg?.startsWith("Recovered"));
    expect(recovery).toMatchObject({ level: 40, requeuedJobs: 1, failedSyncRuns: 1 });
    const run = withDatabase(({ sqlite }) =>
      sqlite
        .prepare("SELECT status, error_message, finished_at FROM sync_runs WHERE id = ?")
        .get(syncRunId),
    );
    expect(run).toMatchObject({ status: "failed", error_message: "Interrupted by a restart" });
    expect((run as { finished_at: number }).finished_at).toBeGreaterThan(0);
  });

  it("does not log a recovery on a clean start", async () => {
    const lines: string[] = [];
    await boot(lines);
    expect(lines.filter((line) => line.includes("Recovered work"))).toHaveLength(0);
  });

  it("serves /api/events to a signed-in client, never caches /api and still shuts down", async () => {
    const { base, origin } = await boot();
    const cookie = await signIn(base, origin);

    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    expect(me.headers.get("cache-control")).toBe("no-store");

    const abort = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let received = "";
    while (!received.includes("event: ready")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    expect(received).toContain("event: ready\ndata: {}\n\n");

    // Leave the stream open: close() in afterEach must not wait for this client to go away.
    const closing = running.pop()?.close();
    await expect(closing).resolves.toBeUndefined();
    abort.abort();
  });
});
