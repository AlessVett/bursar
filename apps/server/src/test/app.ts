import { readFileSync } from "node:fs";
import path from "node:path";
import type { SetupStartResponse } from "@bursar/shared";
import type { Hono } from "hono";
import { pino } from "pino";
import { OwnerStore } from "../auth/owner";
import { FailureLimiter } from "../auth/rate-limit";
import { SESSION_COOKIE } from "../auth/routes";
import { SessionStore } from "../auth/sessions";
import { SetupCode } from "../auth/setup-code";
import { generateTotpCode } from "../auth/totp";
import { type AppEnv, createApp, type MountedRouter } from "../http/app";
import type { TestDatabase } from "./db";

export const TEST_ORIGIN = "https://bursar.example.test";
export const TEST_PASSWORD = "correct horse battery staple";

export interface TestApp {
  app: Hono<AppEnv>;
  /** `bursar_session=<token>` of an authenticated owner session. */
  cookie: string;
  origin: string;
  sessions: SessionStore;
  /** Sends a request as the signed-in owner and parses a JSON (or empty) response body. */
  json(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; body: unknown; headers: Headers }>;
}

export interface CreateTestAppOptions {
  database: TestDatabase;
  routers?: MountedRouter[];
  publicRouters?: MountedRouter[];
  now?: () => number;
}

/**
 * Builds the real application (real auth stores over `database`), completes owner setup through
 * the API and returns the session cookie, so a route test starts already signed in.
 */
export async function createTestApp(options: CreateTestAppOptions): Promise<TestApp> {
  const { database } = options;
  const now = options.now ?? Date.now;
  const sessions = new SessionStore(database.db, now);
  const setupCodeFile = path.join(database.dir, "setup-code");
  const setupCode = new SetupCode(setupCodeFile);
  setupCode.issue();
  const app = createApp({
    config: { publicUrl: new URL(TEST_ORIGIN), cfAccess: null, webDistDir: null },
    logger: pino({ level: "silent" }),
    healthCheck: () => true,
    auth: {
      owners: new OwnerStore(database.db, Buffer.alloc(32, 1)),
      sessions,
      setupCode,
      limiter: new FailureLimiter(5, 15 * 60_000, now),
      accountLimiter: new FailureLimiter(20, 15 * 60_000, now),
      secureCookies: true,
      now,
      getClientIp: () => "203.0.113.7",
    },
    routers: options.routers,
    publicRouters: options.publicRouters,
  });

  const post = (route: string, body: unknown) =>
    app.request(route, {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const start = await post("/api/auth/setup/start", {
    setupCode: readFileSync(setupCodeFile, "utf8").trim(),
    password: TEST_PASSWORD,
  });
  if (start.status !== 200) throw new Error(`Test setup/start failed with ${start.status}`);
  const { setupToken, secret } = (await start.json()) as SetupStartResponse;
  const confirm = await post("/api/auth/setup/confirm", {
    setupToken,
    code: generateTotpCode(secret, now()),
  });
  if (confirm.status !== 200) throw new Error(`Test setup/confirm failed with ${confirm.status}`);
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(
    confirm.headers.get("set-cookie") ?? "",
  );
  if (!match) throw new Error("Test setup did not return a session cookie");
  const cookie = `${SESSION_COOKIE}=${match[1]}`;

  return {
    app,
    cookie,
    origin: TEST_ORIGIN,
    sessions,
    async json(route, init = {}) {
      const response = await app.request(route, {
        method: init.method ?? "GET",
        headers: { origin: TEST_ORIGIN, "content-type": "application/json", cookie },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: response.status, body, headers: response.headers };
    },
  };
}
