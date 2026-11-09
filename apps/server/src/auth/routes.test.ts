import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { SetupStartResponse } from "@bursar/shared";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../http/app";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { OwnerStore } from "./owner";
import { FailureLimiter } from "./rate-limit";
import type { AuthDeps } from "./routes";
import { SessionStore } from "./sessions";
import { SetupCode } from "./setup-code";
import { generateTotpCode } from "./totp";

const ORIGIN = "https://bursar.example.test";
const PASSWORD = "correct horse battery staple";

function sessionCookie(res: Response): string {
  const match = (res.headers.get("set-cookie") ?? "").match(/bursar_session=([^;]+)/);
  if (!match) throw new Error("no session cookie in response");
  return `bursar_session=${match[1]}`;
}

describe("auth routes", () => {
  let t: TestDatabase;
  let now: number;
  let code: string;
  let codeFile: string;
  let clientIp: string;
  let app: ReturnType<typeof createApp>;

  const post = (route: string, body: unknown, cookie?: string) =>
    app.request(route, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const get = (route: string, cookie?: string) =>
    app.request(route, { headers: cookie ? { cookie } : {} });

  async function completeSetup() {
    const start = await post("/api/auth/setup/start", { setupCode: code, password: PASSWORD });
    expect(start.status).toBe(200);
    const body = (await start.json()) as SetupStartResponse;
    const confirm = await post("/api/auth/setup/confirm", {
      setupToken: body.setupToken,
      code: generateTotpCode(body.secret, now),
    });
    expect(confirm.status).toBe(200);
    return { secret: body.secret, cookie: sessionCookie(confirm), confirm };
  }

  beforeEach(() => {
    t = createTestDatabase();
    now = Date.UTC(2026, 10, 9, 9, 0, 0);
    codeFile = path.join(t.dir, "setup-code");
    const setupCode = new SetupCode(codeFile);
    setupCode.issue();
    code = readFileSync(codeFile, "utf8").trim();
    clientIp = "203.0.113.7";
    const auth: AuthDeps = {
      owners: new OwnerStore(t.db, Buffer.alloc(32, 1)),
      sessions: new SessionStore(t.db, () => now),
      setupCode,
      limiter: new FailureLimiter(5, 15 * 60_000, () => now),
      accountLimiter: new FailureLimiter(20, 15 * 60_000, () => now),
      secureCookies: true,
      now: () => now,
      getClientIp: () => clientIp,
    };
    app = createApp({
      config: { publicUrl: new URL(ORIGIN), cfAccess: null, webDistDir: null },
      logger: pino({ level: "silent" }),
      healthCheck: () => true,
      auth,
    });
  });
  afterEach(() => t.dispose());

  it("reports that setup is required before the owner exists", async () => {
    expect(await (await get("/api/auth/status")).json()).toEqual({
      setupRequired: true,
      authenticated: false,
    });
  });

  it("rejects a wrong setup code and a short password", async () => {
    expect(
      (await post("/api/auth/setup/start", { setupCode: "wrong", password: PASSWORD })).status,
    ).toBe(401);
    expect(
      (await post("/api/auth/setup/start", { setupCode: code, password: "short" })).status,
    ).toBe(400);
  });

  it("creates the owner, signs in and consumes the setup code", async () => {
    const { cookie, confirm } = await completeSetup();
    const setCookie = confirm.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(await (await get("/api/auth/status", cookie)).json()).toEqual({
      setupRequired: false,
      authenticated: true,
    });
    expect(existsSync(codeFile)).toBe(false);
    expect(
      (await post("/api/auth/setup/start", { setupCode: code, password: PASSWORD })).status,
    ).toBe(409);
  });

  it("expires an unconfirmed setup after ten minutes", async () => {
    const start = await post("/api/auth/setup/start", { setupCode: code, password: PASSWORD });
    const body = (await start.json()) as SetupStartResponse;
    now += 11 * 60_000;
    const confirm = await post("/api/auth/setup/confirm", {
      setupToken: body.setupToken,
      code: generateTotpCode(body.secret, now),
    });
    expect(confirm.status).toBe(400);
  });

  it("logs in with password and a fresh TOTP code, and protects /api/me", async () => {
    const { secret } = await completeSetup();
    now += 30_000;
    expect((await post("/api/auth/login", { password: "wrong", code: "000000" })).status).toBe(401);
    const login = await post("/api/auth/login", {
      password: PASSWORD,
      code: generateTotpCode(secret, now),
    });
    expect(login.status).toBe(200);
    expect((await get("/api/me", sessionCookie(login))).status).toBe(200);
    expect((await get("/api/me")).status).toBe(401);
  });

  it("refuses to reuse a TOTP code", async () => {
    const { secret } = await completeSetup();
    now += 30_000;
    const totp = generateTotpCode(secret, now);
    expect((await post("/api/auth/login", { password: PASSWORD, code: totp })).status).toBe(200);
    expect((await post("/api/auth/login", { password: PASSWORD, code: totp })).status).toBe(401);
  });

  it("accepts a code only once when two logins race with it", async () => {
    const { secret } = await completeSetup();
    now += 30_000;
    const totp = generateTotpCode(secret, now);
    const results = await Promise.all([
      post("/api/auth/login", { password: PASSWORD, code: totp }),
      post("/api/auth/login", { password: PASSWORD, code: totp }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const cookies = results.filter((r) =>
      /bursar_session=[^;]+/.test(r.headers.get("set-cookie") ?? ""),
    );
    expect(cookies).toHaveLength(1);
  });

  it("refuses the enrolment code at login", async () => {
    const start = await post("/api/auth/setup/start", { setupCode: code, password: PASSWORD });
    const { setupToken, secret } = (await start.json()) as SetupStartResponse;
    const enrolmentCode = generateTotpCode(secret, now);
    const confirm = await post("/api/auth/setup/confirm", { setupToken, code: enrolmentCode });
    expect(confirm.status).toBe(200);
    expect(
      (await post("/api/auth/login", { password: PASSWORD, code: enrolmentCode })).status,
    ).toBe(401);
  });

  it("locks out after five failed logins", async () => {
    const { secret } = await completeSetup();
    for (let i = 0; i < 5; i += 1) {
      await post("/api/auth/login", { password: "wrong", code: "000000" });
    }
    now += 30_000;
    const res = await post("/api/auth/login", {
      password: PASSWORD,
      code: generateTotpCode(secret, now),
    });
    expect(res.status).toBe(429);
  });

  it("caps a concurrent burst of wrong logins at five verifications", async () => {
    const { secret } = await completeSetup();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        post("/api/auth/login", { password: "wrong", code: "000000" }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    now += 30_000;
    const res = await post("/api/auth/login", {
      password: PASSWORD,
      code: generateTotpCode(secret, now),
    });
    expect(res.status).toBe(429);
  });

  it("treats rotating addresses inside one IPv6 /64 as one client", async () => {
    await completeSetup();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      clientIp = `2001:db8::${i}`;
      statuses.push((await post("/api/auth/login", { password: "wrong", code: "000000" })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    clientIp = "2001:db8:0:1::1";
    expect((await post("/api/auth/login", { password: "wrong", code: "000000" })).status).toBe(401);
  });

  it("caps failed logins across all addresses for the owner account", async () => {
    const { secret } = await completeSetup();
    for (let i = 0; i < 20; i += 1) {
      clientIp = `198.51.100.${i}`;
      expect((await post("/api/auth/login", { password: "wrong", code: "000000" })).status).toBe(
        401,
      );
    }
    clientIp = "198.51.100.200";
    now += 30_000;
    const blocked = await post("/api/auth/login", {
      password: PASSWORD,
      code: generateTotpCode(secret, now),
    });
    expect(blocked.status).toBe(429);
    now += 15 * 60_000;
    const login = await post("/api/auth/login", {
      password: PASSWORD,
      code: generateTotpCode(secret, now),
    });
    expect(login.status).toBe(200);
  });

  it("clears the account-wide count after a successful login", async () => {
    const { secret } = await completeSetup();
    for (let i = 0; i < 19; i += 1) {
      clientIp = `198.51.100.${i}`;
      await post("/api/auth/login", { password: "wrong", code: "000000" });
    }
    now += 30_000;
    const login = await post("/api/auth/login", {
      password: PASSWORD,
      code: generateTotpCode(secret, now),
    });
    expect(login.status).toBe(200);
    clientIp = "198.51.100.100";
    for (let i = 0; i < 2; i += 1) {
      expect((await post("/api/auth/login", { password: "wrong", code: "000000" })).status).toBe(
        401,
      );
    }
  });

  it("limits setup attempts per IPv6 /64", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      clientIp = `2001:db8::${i}`;
      statuses.push(
        (await post("/api/auth/setup/start", { setupCode: "wrong", password: PASSWORD })).status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("revokes the session on logout", async () => {
    const { cookie } = await completeSetup();
    expect((await post("/api/auth/logout", {}, cookie)).status).toBe(200);
    expect((await get("/api/me", cookie)).status).toBe(401);
  });
});
