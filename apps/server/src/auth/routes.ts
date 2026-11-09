import { randomBytes } from "node:crypto";
import {
  type AuthStatus,
  loginRequestSchema,
  type SetupStartResponse,
  setupConfirmRequestSchema,
  setupStartRequestSchema,
} from "@bursar/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../http/app";
import type { OwnerStore } from "./owner";
import { hashPassword, verifyPassword } from "./passwords";
import type { FailureLimiter } from "./rate-limit";
import { SESSION_IDLE_MS, type SessionStore } from "./sessions";
import type { SetupCode } from "./setup-code";
import { createTotpSetup, verifyTotp } from "./totp";

export const SESSION_COOKIE = "bursar_session";
const PENDING_SETUP_TTL_MS = 10 * 60_000;

export interface AuthDeps {
  owners: OwnerStore;
  sessions: SessionStore;
  setupCode: SetupCode;
  limiter: FailureLimiter;
  secureCookies: boolean;
  now: () => number;
  getClientIp: (c: Context) => string;
}

interface PendingSetup {
  passwordHash: string;
  secret: string;
  expiresAt: number;
}

async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

export function authRoutes(deps: AuthDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const pending = new Map<string, PendingSetup>();

  const startSession = (c: Context) => {
    const token = deps.sessions.create(c.req.header("user-agent") ?? null);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: deps.secureCookies,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_IDLE_MS / 1000,
    });
  };

  routes.get("/status", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const status: AuthStatus = {
      setupRequired: !deps.owners.exists(),
      authenticated: token ? deps.sessions.validate(token) !== null : false,
    };
    return c.json(status);
  });

  routes.post("/setup/start", async (c) => {
    if (deps.owners.exists()) return c.json({ error: "Already set up" }, 409);
    const ip = deps.getClientIp(c);
    // Charge the attempt synchronously, before any await, so a parallel burst cannot bypass the cap.
    if (!deps.limiter.tryConsume(ip)) return c.json({ error: "Too many attempts" }, 429);
    const parsed = setupStartRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    if (!deps.setupCode.verify(parsed.data.setupCode)) {
      return c.json({ error: "Invalid setup code" }, 401);
    }
    deps.limiter.reset(ip);
    const totp = createTotpSetup("owner");
    const setupToken = randomBytes(24).toString("base64url");
    pending.set(setupToken, {
      passwordHash: await hashPassword(parsed.data.password),
      secret: totp.secret,
      expiresAt: deps.now() + PENDING_SETUP_TTL_MS,
    });
    const response: SetupStartResponse = { setupToken, otpauthUri: totp.uri, secret: totp.secret };
    return c.json(response);
  });

  routes.post("/setup/confirm", async (c) => {
    if (deps.owners.exists()) return c.json({ error: "Already set up" }, 409);
    const parsed = setupConfirmRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const entry = pending.get(parsed.data.setupToken);
    if (!entry || entry.expiresAt < deps.now()) {
      pending.delete(parsed.data.setupToken);
      return c.json({ error: "Setup expired, start again" }, 400);
    }
    const check = verifyTotp(entry.secret, parsed.data.code, 0, deps.now());
    if (!check.ok) return c.json({ error: "Invalid code" }, 401);
    deps.owners.create(
      { passwordHash: entry.passwordHash, totpSecret: entry.secret, lastTotpStep: check.step },
      new Date(deps.now()),
    );
    pending.clear();
    deps.setupCode.clear();
    startSession(c);
    return c.json({ ok: true });
  });

  routes.post("/login", async (c) => {
    const ip = deps.getClientIp(c);
    // Charge the attempt synchronously, before any await, so a parallel burst cannot bypass the cap.
    if (!deps.limiter.tryConsume(ip)) return c.json({ error: "Too many attempts" }, 429);
    const parsed = loginRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const record = deps.owners.get();
    if (!record) return c.json({ error: "Setup required" }, 409);
    const passwordOk = await verifyPassword(record.passwordHash, parsed.data.password);
    const totp = verifyTotp(record.totpSecret, parsed.data.code, record.lastTotpStep, deps.now());
    if (!passwordOk || !totp.ok) {
      return c.json({ error: "Invalid credentials" }, 401);
    }
    deps.owners.setLastTotpStep(totp.step);
    deps.limiter.reset(ip);
    startSession(c);
    return c.json({ ok: true });
  });

  routes.post("/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deps.sessions.revoke(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return routes;
}

export function requireSession(sessions: SessionStore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.path.startsWith("/api/auth/")) return next();
    const token = getCookie(c, SESSION_COOKIE);
    const sessionId = token ? sessions.validate(token) : null;
    if (sessionId === null) return c.json({ error: "Not authenticated" }, 401);
    c.set("sessionId", sessionId);
    await next();
  };
}
