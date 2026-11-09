# M0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deployable skeleton of Bursar: an encrypted single-process TypeScript service with owner login (password + TOTP), a job queue, a scheduler, a minimal bilingual panel, a Docker image and compose stack, CI, and the three M0 verification gates. It ends deployed behind Cloudflare Tunnel and Access.

**Architecture:** pnpm workspace with `apps/server` (Hono on Node 24, SQLCipher through `better-sqlite3-multiple-ciphers` and Drizzle), `apps/web` (React, Vite, Tailwind, i18next) and `packages/shared` (Zod schemas). The server serves the built panel and the JSON API from one process. Deployment is Docker Compose built from source on the host; CI runs only checks.

**Tech Stack:** Node 24 LTS, pnpm 12, TypeScript 7, Hono 4 with `@hono/node-server` 2, Drizzle ORM 0.45 and drizzle-kit 0.31, `better-sqlite3-multiple-ciphers` 13, `@node-rs/argon2`, `otpauth`, `jose` 6, Zod 4, pino 10, Vitest 5, Biome 2, lefthook 2, gitleaks 8, React 19, Vite 8, Tailwind 4, TanStack Query 5, i18next 27, Docker Compose, Cloudflare Tunnel and Access, GitHub Actions.

Spec: `docs/superpowers/specs/2026-11-09-bursar-design.md` (milestone M0, §14).

## Global Constraints

- Node 24 LTS in the container and CI (`.nvmrc` = `24`); package manager pnpm only, pinned through `packageManager`.
- Code, comments, docs and commit messages in English; Conventional Commits (`type(scope): description`).
- No personal identifiers in the repository: no real hostnames, server aliases, IPs, account data or names other than the licence holder. Operator values live only in the host's `.env` and secrets files.
- Secrets come from an environment variable or its `*_FILE` variant; they are never logged, printed or committed.
- No container publishes ports in production; local development binds `127.0.0.1` only.
- Session cookies: `HttpOnly`, `SameSite=Strict`, `Secure` whenever the public URL is HTTPS. Mutating `/api` requests must carry an `Origin` equal to the public URL's origin.
- CI runs only on GitHub-hosted `ubuntu-latest`; no self-hosted, macOS or Windows runners, no matrices.
- Tests: every task's tests must actually run; a run with zero executed tests is a failure. Paste the full Vitest summary line (`Test Files … Tests …`) as verification.
- Git: work on branch `feat/m0-foundation`; `git add` explicit paths only (never `-A` or `.`); run `git status` and `git diff --cached` before each commit.
- **Owner gates:** steps marked **Owner gate** (installing system tools, starting containers, deploying, pushing, merging, publishing, entering credentials) require the owner's explicit go-ahead at that moment.
- Run `pnpm format` before `pnpm lint` in every task: Biome's formatting and import ordering are authoritative over the snippets below.
- If an installed major version's API differs from the code below, keep the exported names and signatures from the task's **Interfaces** block and adapt the internals following the library's documentation; record the difference in the commit message body.

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, biome.json, lefthook.yml, .nvmrc, .dockerignore
LICENSE, README.md
packages/shared/src/{index.ts, auth.ts, auth.test.ts}
apps/server/
  drizzle.config.ts, tsup.config.ts, vitest.config.ts, .env.example
  drizzle/                      generated SQL migrations
  src/config.ts                 environment and *_FILE secrets
  src/crypto.ts                 HKDF key derivation, AES-256-GCM seal/unseal
  src/logger.ts                 pino with redaction
  src/db/{schema.ts, index.ts}  SQLCipher + Drizzle
  src/jobs/{queue.ts, worker.ts}
  src/scheduler.ts, src/maintenance.ts
  src/http/{app.ts, access.ts, origin.ts, static.ts}
  src/auth/{passwords.ts, totp.ts, owner.ts, sessions.ts, setup-code.ts, rate-limit.ts, routes.ts}
  src/server.ts                 wiring: startBursar()
  src/index.ts                  process entrypoint
  src/cli.ts                    `bursar init`
  src/gates/sdk-gate.ts         gate V2 probe
  src/test/db.ts                test helper
apps/web/
  index.html, vite.config.ts, vitest.config.ts
  src/{main.tsx, App.tsx, api.ts, styles.css}
  src/i18n/{index.ts, en.json, it.json}
  src/components/{ui.tsx, LanguageSwitcher.tsx}
  src/pages/{SetupPage.tsx, LoginPage.tsx, HomePage.tsx}
  src/test/setup.ts
deploy/
  Dockerfile, compose.yaml, compose.dev.yaml, compose.claude.yaml, env.example
  deploy.sh, remote-update.sh
docs/decisions/{0001-sqlcipher.md, 0002-agent-sdk-container.md, 0003-sdk-redistribution.md}
docs/deployment.md
.github/workflows/ci.yml
```

---

### Task 1: Workspace, toolchain and shared schemas

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `lefthook.yml`, `.nvmrc`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/vitest.config.ts`, `packages/shared/src/index.ts`, `packages/shared/src/auth.ts`
- Test: `packages/shared/src/auth.test.ts`

**Interfaces:**
- Produces (`@bursar/shared`): `PASSWORD_MIN_LENGTH = 12`; Zod schemas `totpCodeSchema`, `setupStartRequestSchema` → `SetupStartRequest { setupCode: string; password: string }`, `setupStartResponseSchema` → `SetupStartResponse { setupToken: string; otpauthUri: string; secret: string }`, `setupConfirmRequestSchema` → `SetupConfirmRequest { setupToken: string; code: string }`, `loginRequestSchema` → `LoginRequest { password: string; code: string }`, `authStatusSchema` → `AuthStatus { setupRequired: boolean; authenticated: boolean }`.

- [ ] **Step 1: Create the branch and prepare the toolchain (Owner gate for the installs)**

```bash
git switch -c feat/m0-foundation
nvm install 24 && nvm use 24
brew install gitleaks
node --version && gitleaks version
```

Expected: `v24.x.x` and `8.x.x`.

- [ ] **Step 2: Write the root workspace files**

`.nvmrc`:

```
24
```

`package.json`:

```json
{
  "name": "bursar",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.18.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "prepare": "test -d .git && lefthook install || true",
    "lint": "biome check .",
    "format": "biome check --write .",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "build": "pnpm --filter @bursar/web build && pnpm --filter @bursar/server build"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.6.6",
    "lefthook": "^2.2.2",
    "typescript": "^7.0.2"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*

allowBuilds:
  esbuild: true
  lefthook: true
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  }
}
```

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.6.6/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/drizzle/meta"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } },
  "assist": { "enabled": true, "actions": { "source": { "organizeImports": "on" } } }
}
```

`lefthook.yml`:

```yaml
pre-commit:
  parallel: true
  commands:
    biome:
      glob: "*.{ts,tsx,js,json,css}"
      run: pnpm exec biome check --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}
    gitleaks:
      run: gitleaks git --pre-commit --staged --redact --no-banner
```

- [ ] **Step 3: Write the shared package skeleton**

`packages/shared/package.json`:

```json
{
  "name": "@bursar/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": { "zod": "^4.6.7" },
  "devDependencies": { "typescript": "^7.0.2", "vitest": "^5.1.0" }
}
```

`packages/shared/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "vitest.config.ts"] }
```

`packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

- [ ] **Step 4: Write the failing test**

`packages/shared/src/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loginRequestSchema, setupStartRequestSchema, totpCodeSchema } from "./auth";

describe("auth schemas", () => {
  it("accepts a six-digit TOTP code and rejects anything else", () => {
    expect(totpCodeSchema.safeParse("123456").success).toBe(true);
    expect(totpCodeSchema.safeParse("12345").success).toBe(false);
    expect(totpCodeSchema.safeParse("12345a").success).toBe(false);
  });

  it("requires a setup code and a password of at least 12 characters", () => {
    expect(setupStartRequestSchema.safeParse({ setupCode: "abc", password: "short" }).success).toBe(
      false,
    );
    expect(
      setupStartRequestSchema.safeParse({ setupCode: "", password: "a-long-enough-pass" }).success,
    ).toBe(false);
    expect(
      setupStartRequestSchema.safeParse({ setupCode: "abc", password: "a-long-enough-pass" })
        .success,
    ).toBe(true);
  });

  it("accepts any non-empty password at login", () => {
    expect(loginRequestSchema.safeParse({ password: "x", code: "000000" }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: "", code: "000000" }).success).toBe(false);
  });
});
```

- [ ] **Step 5: Install and run the test to verify it fails**

Run: `pnpm install && pnpm --filter @bursar/shared test`
Expected: FAIL, `Failed to resolve import "./auth"`. If `pnpm install` stops with `ERR_PNPM_IGNORED_BUILDS`, add each listed package to `allowBuilds` (true only for packages that need their install script: native binaries, lefthook) and rerun.

- [ ] **Step 6: Write the implementation**

`packages/shared/src/auth.ts`:

```ts
import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 12;

export const totpCodeSchema = z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits");

export const setupStartRequestSchema = z.object({
  setupCode: z.string().trim().min(1).max(128),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
});
export type SetupStartRequest = z.infer<typeof setupStartRequestSchema>;

export const setupStartResponseSchema = z.object({
  setupToken: z.string(),
  otpauthUri: z.string(),
  secret: z.string(),
});
export type SetupStartResponse = z.infer<typeof setupStartResponseSchema>;

export const setupConfirmRequestSchema = z.object({
  setupToken: z.string().min(1),
  code: totpCodeSchema,
});
export type SetupConfirmRequest = z.infer<typeof setupConfirmRequestSchema>;

export const loginRequestSchema = z.object({
  password: z.string().min(1).max(256),
  code: totpCodeSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authStatusSchema = z.object({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;
```

`packages/shared/src/index.ts`:

```ts
export * from "./auth";
```

- [ ] **Step 7: Run tests, lint and typecheck**

Run: `pnpm --filter @bursar/shared test && pnpm lint && pnpm typecheck`
Expected: `Tests  3 passed (3)`; Biome reports no errors; `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git status
git add .nvmrc package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json biome.json lefthook.yml packages/shared
git diff --cached --stat
git commit -m "build: set up pnpm workspace, toolchain and shared auth schemas"
```

Expected: the lefthook pre-commit hook runs Biome and gitleaks and both pass.

---

### Task 2: Server package and configuration loader

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/src/config.ts`
- Test: `apps/server/src/config.test.ts`

**Interfaces:**
- Produces: `class ConfigError extends Error { problems: string[] }`; `type ClaudeCredential = { envName: "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN"; value: string }`; `interface Config { host: string; port: number; publicUrl: URL; dataDir: string; timezone: string; logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace"; masterKey: Buffer; migrationsDir: string; webDistDir: string | null; cfAccess: { teamDomain: string; audience: string } | null; claude: ClaudeCredential | null }`; `readSecret(env, name, readFile?): string | undefined`; `loadClaudeCredential(env, readFile?): ClaudeCredential | null`; `loadConfig(env?, readFile?): Config`. `env` is `Record<string, string | undefined>`, `readFile` is `(path: string) => string`.

- [ ] **Step 1: Write the server package files**

`apps/server/package.json` (dependencies for all of M0 except the Agent SDK, added in Task 13):

```json
{
  "name": "@bursar/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=.env src/index.ts",
    "build": "tsup",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p .",
    "db:generate": "drizzle-kit generate",
    "bursar": "tsx src/cli.ts"
  },
  "dependencies": {
    "@bursar/shared": "workspace:*",
    "@hono/node-server": "^2.1.6",
    "@node-rs/argon2": "^2.2.2",
    "better-sqlite3-multiple-ciphers": "^13.0.3",
    "drizzle-orm": "^0.45.4",
    "hono": "^4.13.17",
    "jose": "^6.2.16",
    "otpauth": "^9.6.0",
    "pino": "^10.4.0",
    "zod": "^4.6.7"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "drizzle-kit": "^0.31.11",
    "tsup": "^9.0.0",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2",
    "vitest": "^5.1.0"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "*.config.ts"]
}
```

`apps/server/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 15_000 },
});
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`apps/server/src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, readSecret } from "./config";

const KEY = Buffer.alloc(32, 7).toString("base64");
const baseEnv = {
  BURSAR_PUBLIC_URL: "https://bursar.example.test",
  TZ: "Europe/Rome",
  BURSAR_MASTER_KEY: KEY,
};
const noFiles = (path: string): string => {
  throw new Error(`unexpected read of ${path}`);
};

describe("loadConfig", () => {
  it("builds a config with defaults from the minimal environment", () => {
    const config = loadConfig(baseEnv, noFiles);
    expect(config.port).toBe(8080);
    expect(config.host).toBe("127.0.0.1");
    expect(config.publicUrl.origin).toBe("https://bursar.example.test");
    expect(config.timezone).toBe("Europe/Rome");
    expect(config.masterKey).toEqual(Buffer.alloc(32, 7));
    expect(config.cfAccess).toBeNull();
    expect(config.claude).toBeNull();
    expect(config.webDistDir).toBeNull();
  });

  it("reports every problem at once", () => {
    let error: unknown;
    try {
      loadConfig({}, noFiles);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems.join("\n");
    expect(problems).toContain("BURSAR_PUBLIC_URL");
    expect(problems).toContain("TZ");
    expect(problems).toContain("BURSAR_MASTER_KEY");
  });

  it("reads the master key from a *_FILE path", () => {
    const env = { ...baseEnv, BURSAR_MASTER_KEY: undefined, BURSAR_MASTER_KEY_FILE: "/run/key" };
    const config = loadConfig(env, (path) => {
      expect(path).toBe("/run/key");
      return `${KEY}\n`;
    });
    expect(config.masterKey).toEqual(Buffer.alloc(32, 7));
  });

  it("rejects a master key that is not 32 bytes", () => {
    const env = { ...baseEnv, BURSAR_MASTER_KEY: Buffer.alloc(16).toString("base64") };
    expect(() => loadConfig(env, noFiles)).toThrow(/32 bytes/);
  });

  it("rejects an unknown timezone", () => {
    expect(() => loadConfig({ ...baseEnv, TZ: "Mars/Olympus" }, noFiles)).toThrow(
      /not a valid IANA timezone/,
    );
  });

  it("requires both Cloudflare Access settings together", () => {
    expect(() => loadConfig({ ...baseEnv, CF_ACCESS_AUD: "aud" }, noFiles)).toThrow(
      /must be set together/,
    );
  });

  it("enables Cloudflare Access when both settings are present", () => {
    const config = loadConfig(
      { ...baseEnv, CF_ACCESS_TEAM_DOMAIN: "team.example.test", CF_ACCESS_AUD: "aud" },
      noFiles,
    );
    expect(config.cfAccess).toEqual({ teamDomain: "team.example.test", audience: "aud" });
  });

  it("rejects two Claude credentials at once", () => {
    const env = { ...baseEnv, ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "b" };
    expect(() => loadConfig(env, noFiles)).toThrow(/not both/);
  });

  it("loads an OAuth token credential", () => {
    const config = loadConfig({ ...baseEnv, CLAUDE_CODE_OAUTH_TOKEN: "tok" }, noFiles);
    expect(config.claude).toEqual({ envName: "CLAUDE_CODE_OAUTH_TOKEN", value: "tok" });
  });
});

describe("readSecret", () => {
  it("refuses a variable and its _FILE variant together", () => {
    expect(() => readSecret({ A: "x", A_FILE: "/f" }, "A", noFiles)).toThrow(ConfigError);
  });

  it("rejects an empty secret file", () => {
    expect(() => readSecret({ A_FILE: "/f" }, "A", () => "  \n")).toThrow(/empty/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @bursar/server test src/config.test.ts`
Expected: FAIL, `Failed to resolve import "./config"`.

- [ ] **Step 4: Write the implementation**

`apps/server/src/config.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

export type ClaudeCredential = {
  envName: "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN";
  value: string;
};

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

export interface Config {
  host: string;
  port: number;
  publicUrl: URL;
  dataDir: string;
  timezone: string;
  logLevel: (typeof LOG_LEVELS)[number];
  masterKey: Buffer;
  migrationsDir: string;
  webDistDir: string | null;
  cfAccess: { teamDomain: string; audience: string } | null;
  claude: ClaudeCredential | null;
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (file) => readFileSync(file, "utf8");

export function readSecret(
  env: Env,
  name: string,
  readFile: ReadFile = defaultReadFile,
): string | undefined {
  const direct = env[name]?.trim();
  const filePath = env[`${name}_FILE`]?.trim();
  if (direct && filePath) {
    throw new ConfigError([`${name} and ${name}_FILE are both set; use one`]);
  }
  if (filePath) {
    const value = readFile(filePath).trim();
    if (!value) throw new ConfigError([`${name}_FILE points to an empty file`]);
    return value;
  }
  return direct || undefined;
}

export function loadClaudeCredential(
  env: Env,
  readFile: ReadFile = defaultReadFile,
): ClaudeCredential | null {
  const apiKey = readSecret(env, "ANTHROPIC_API_KEY", readFile);
  const oauthToken = readSecret(env, "CLAUDE_CODE_OAUTH_TOKEN", readFile);
  if (apiKey && oauthToken) {
    throw new ConfigError(["Set either ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, not both"]);
  }
  if (apiKey) return { envName: "ANTHROPIC_API_KEY", value: apiKey };
  if (oauthToken) return { envName: "CLAUDE_CODE_OAUTH_TOKEN", value: oauthToken };
  return null;
}

export function loadConfig(
  env: Env = process.env,
  readFile: ReadFile = defaultReadFile,
): Config {
  const problems: string[] = [];
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
      return undefined;
    }
  };

  const port = Number(env.BURSAR_PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("BURSAR_PORT must be an integer between 1 and 65535");
  }

  let publicUrl: URL | undefined;
  if (!env.BURSAR_PUBLIC_URL) {
    problems.push("BURSAR_PUBLIC_URL is required");
  } else {
    try {
      publicUrl = new URL(env.BURSAR_PUBLIC_URL);
    } catch {
      problems.push("BURSAR_PUBLIC_URL must be an absolute URL");
    }
  }

  const timezone = env.TZ;
  if (!timezone) {
    problems.push("TZ is required (an IANA timezone such as Europe/Rome)");
  } else {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      problems.push(`TZ "${timezone}" is not a valid IANA timezone`);
    }
  }

  const logLevel = env.BURSAR_LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.includes(logLevel as Config["logLevel"])) {
    problems.push(`BURSAR_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }

  let masterKey: Buffer | undefined;
  const problemsBeforeKey = problems.length;
  const rawKey = attempt(() => readSecret(env, "BURSAR_MASTER_KEY", readFile));
  if (rawKey) {
    const decoded = Buffer.from(rawKey, "base64");
    if (decoded.length === 32) masterKey = decoded;
    else problems.push("BURSAR_MASTER_KEY must be 32 bytes encoded as base64");
  } else if (problems.length === problemsBeforeKey) {
    problems.push("BURSAR_MASTER_KEY (or BURSAR_MASTER_KEY_FILE) is required");
  }

  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.CF_ACCESS_AUD?.trim();
  if (Boolean(teamDomain) !== Boolean(audience)) {
    problems.push("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set together");
  }

  const claude = attempt(() => loadClaudeCredential(env, readFile)) ?? null;

  if (problems.length > 0 || !publicUrl || !timezone || !masterKey) {
    throw new ConfigError(problems);
  }

  return {
    host: env.BURSAR_HOST ?? "127.0.0.1",
    port,
    publicUrl,
    dataDir: path.resolve(env.BURSAR_DATA_DIR ?? "./data"),
    timezone,
    logLevel: logLevel as Config["logLevel"],
    masterKey,
    migrationsDir: path.resolve(env.BURSAR_MIGRATIONS_DIR ?? "./drizzle"),
    webDistDir: env.BURSAR_WEB_DIST ? path.resolve(env.BURSAR_WEB_DIST) : null,
    cfAccess: teamDomain && audience ? { teamDomain, audience } : null,
    claude,
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @bursar/server test src/config.test.ts && pnpm --filter @bursar/server typecheck`
Expected: `Tests  11 passed (11)`; `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json apps/server/tsconfig.json apps/server/vitest.config.ts apps/server/src/config.ts apps/server/src/config.test.ts pnpm-lock.yaml
git diff --cached --stat
git commit -m "feat(server): add configuration loader with *_FILE secrets"
```

---

### Task 3: Key derivation and authenticated encryption

**Files:**
- Create: `apps/server/src/crypto.ts`
- Test: `apps/server/src/crypto.test.ts`

**Interfaces:**
- Produces: `type KeyPurpose = "database" | "totp" | "documents"`; `generateMasterKey(): string` (base64 of 32 random bytes); `deriveKey(master: Buffer, purpose: KeyPurpose): Buffer` (32 bytes, HKDF-SHA256, info `bursar:<purpose>:v1`); `seal(key: Buffer, plaintext: Buffer): Buffer` (layout `[0x01][12-byte nonce][ciphertext][16-byte tag]`); `unseal(key: Buffer, sealed: Buffer): Buffer` (throws on tampering or wrong key).

- [ ] **Step 1: Write the failing test**

`apps/server/src/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveKey, generateMasterKey, seal, unseal } from "./crypto";

const master = Buffer.alloc(32, 9);

describe("deriveKey", () => {
  it("is deterministic and separates purposes", () => {
    expect(deriveKey(master, "database")).toEqual(deriveKey(master, "database"));
    expect(deriveKey(master, "database")).not.toEqual(deriveKey(master, "totp"));
    expect(deriveKey(master, "documents")).toHaveLength(32);
  });

  it("rejects a master key of the wrong size", () => {
    expect(() => deriveKey(Buffer.alloc(16), "totp")).toThrow(/32 bytes/);
  });
});

describe("seal and unseal", () => {
  const key = deriveKey(master, "totp");

  it("round-trips data with a fresh nonce each time", () => {
    const first = seal(key, Buffer.from("secret"));
    const second = seal(key, Buffer.from("secret"));
    expect(first).not.toEqual(second);
    expect(unseal(key, first).toString()).toBe("secret");
  });

  it("detects tampering", () => {
    const sealed = seal(key, Buffer.from("secret"));
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff;
    expect(() => unseal(key, sealed)).toThrow();
  });

  it("refuses the wrong key", () => {
    const sealed = seal(key, Buffer.from("secret"));
    expect(() => unseal(deriveKey(master, "documents"), sealed)).toThrow();
  });

  it("refuses an unknown format version", () => {
    const sealed = seal(key, Buffer.from("secret"));
    sealed[0] = 2;
    expect(() => unseal(key, sealed)).toThrow(/version/);
  });
});

describe("generateMasterKey", () => {
  it("produces 32 random bytes as base64", () => {
    const value = generateMasterKey();
    expect(Buffer.from(value, "base64")).toHaveLength(32);
    expect(value).not.toBe(generateMasterKey());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bursar/server test src/crypto.test.ts`
Expected: FAIL, `Failed to resolve import "./crypto"`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type KeyPurpose = "database" | "totp" | "documents";

const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}

export function deriveKey(master: Buffer, purpose: KeyPurpose): Buffer {
  if (master.length !== 32) throw new Error("The master key must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `bursar:${purpose}:v1`, 32));
}

export function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, ciphertext, cipher.getAuthTag()]);
}

export function unseal(key: Buffer, sealed: Buffer): Buffer {
  if (sealed[0] !== FORMAT_VERSION) throw new Error("Unsupported sealed data version");
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error("Sealed data is truncated");
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ciphertext = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @bursar/server test src/crypto.test.ts`
Expected: `Tests  7 passed (7)`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/crypto.ts apps/server/src/crypto.test.ts
git commit -m "feat(server): add HKDF key derivation and AES-256-GCM sealing"
```

---

### Task 4: Encrypted database, schema, migrations (gate V1)

**Files:**
- Create: `apps/server/drizzle.config.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/index.ts`, `apps/server/src/test/db.ts`, `apps/server/drizzle/` (generated), `docs/decisions/0001-sqlcipher.md`
- Test: `apps/server/src/db/db.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: tables `owner`, `authSessions` (`auth_sessions`), `jobs` exported from `db/schema.ts`; `type Sqlite` (raw handle), `type BursarDb` (Drizzle instance), `interface OpenedDatabase { sqlite: Sqlite; db: BursarDb; close(): void }`, `openDatabase(file: string, passphrase: string): OpenedDatabase` (throws `Cannot open encrypted database …` on a wrong passphrase), `runMigrations(db: BursarDb, migrationsFolder: string): void`. Test helper: `createTestDatabase(): TestDatabase` (adds `dir`, `file`, `dispose()`), `MIGRATIONS_DIR`, `TEST_PASSPHRASE`.

- [ ] **Step 1: Write the schema and drizzle-kit config**

`apps/server/src/db/schema.ts`:

```ts
import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const owner = sqliteTable("owner", {
  id: integer("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEnc: blob("totp_secret_enc", { mode: "buffer" }).notNull(),
  lastTotpStep: integer("last_totp_step").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  userAgent: text("user_agent"),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: integer("run_after").notNull(),
    lockedAt: integer("locked_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("jobs_claim_idx").on(table.status, table.runAfter)],
);
```

`apps/server/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

- [ ] **Step 2: Generate the first migration**

Run: `pnpm --filter @bursar/server db:generate --name init`
Expected: `apps/server/drizzle/0000_init.sql` with `CREATE TABLE` statements for `owner`, `auth_sessions` and `jobs`, plus `drizzle/meta/`.

- [ ] **Step 3: Write the test helper and the failing test**

`apps/server/src/test/db.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type OpenedDatabase, openDatabase, runMigrations } from "../db";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../drizzle");
export const TEST_PASSPHRASE = "test-passphrase-0123456789abcdef";

export interface TestDatabase extends OpenedDatabase {
  dir: string;
  file: string;
  dispose(): void;
}

export function createTestDatabase(): TestDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "bursar-test-"));
  const file = path.join(dir, "test.db");
  const opened = openDatabase(file, TEST_PASSPHRASE);
  runMigrations(opened.db, MIGRATIONS_DIR);
  return {
    ...opened,
    dir,
    file,
    dispose: () => {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
```

`apps/server/src/db/db.test.ts`:

```ts
import { closeSync, openSync, readSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_PASSPHRASE, type TestDatabase } from "../test/db";
import { openDatabase } from "./index";
import { owner } from "./schema";

function fileHeader(file: string): string {
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(16);
  readSync(fd, buffer, 0, 16, 0);
  closeSync(fd);
  return buffer.toString("latin1");
}

function insertOwner(t: TestDatabase): void {
  t.db
    .insert(owner)
    .values({
      id: 1,
      passwordHash: "hash",
      totpSecretEnc: Buffer.from("s"),
      lastTotpStep: 0,
      createdAt: new Date(0),
    })
    .run();
}

describe("encrypted database (gate V1)", () => {
  let t: TestDatabase | undefined;
  afterEach(() => t?.dispose());

  it("writes a file that is not readable as plain SQLite", () => {
    t = createTestDatabase();
    insertOwner(t);
    t.close();
    expect(fileHeader(t.file)).not.toBe("SQLite format 3\u0000");
  });

  it("reopens with the right passphrase and refuses a wrong one", () => {
    t = createTestDatabase();
    insertOwner(t);
    t.close();
    expect(() => openDatabase(t?.file ?? "", "wrong-passphrase")).toThrow(
      /Cannot open encrypted database/,
    );
    const reopened = openDatabase(t.file, TEST_PASSPHRASE);
    const row = reopened.db.select().from(owner).where(eq(owner.id, 1)).get();
    expect(row?.passwordHash).toBe("hash");
    reopened.close();
  });

  it("supports FTS5 full-text search", () => {
    t = createTestDatabase();
    t.sqlite.exec("CREATE VIRTUAL TABLE notes_fts USING fts5(body)");
    t.sqlite
      .prepare("INSERT INTO notes_fts (body) VALUES (?), (?)")
      .run("mortgage amortisation schedule", "grocery receipt");
    const rows = t.sqlite
      .prepare("SELECT body FROM notes_fts WHERE notes_fts MATCH ?")
      .all("amortisation") as { body: string }[];
    expect(rows.map((row) => row.body)).toEqual(["mortgage amortisation schedule"]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @bursar/server test src/db/db.test.ts`
Expected: FAIL, `Failed to resolve import "../db"`.

- [ ] **Step 5: Write the implementation**

`apps/server/src/db/index.ts`:

```ts
import Database from "better-sqlite3-multiple-ciphers";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Sqlite = Database.Database;
export type BursarDb = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  sqlite: Sqlite;
  db: BursarDb;
  close(): void;
}

export function openDatabase(file: string, passphrase: string): OpenedDatabase {
  const sqlite = new Database(file);
  try {
    sqlite.pragma("cipher = 'sqlcipher'");
    sqlite.pragma("legacy = 4");
    sqlite.pragma(`key = '${passphrase.replaceAll("'", "''")}'`);
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
  } catch (error) {
    sqlite.close();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot open encrypted database at ${file}: ${reason}`);
  }
  const db = drizzle({ client: sqlite, schema });
  return { sqlite, db, close: () => sqlite.close() };
}

export function runMigrations(db: BursarDb, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
}
```

If `tsc` reports that the `better-sqlite3-multiple-ciphers` instance is not assignable to Drizzle's `client` type, pass `client: sqlite as unknown as Parameters<typeof drizzle>[0]["client"]` and keep a one-line comment explaining the fork's separate type declarations.

- [ ] **Step 6: Run the gate tests**

Run: `pnpm --filter @bursar/server test src/db/db.test.ts && pnpm --filter @bursar/server typecheck`
Expected: `Tests  3 passed (3)`. If FTS5 or encryption fails, stop: this is gate V1. Record the failure in the decision document (Step 7) and apply the fallback from spec §15 (V1) in a separate, reviewed change.

- [ ] **Step 7: Record the gate result**

`docs/decisions/0001-sqlcipher.md`:

````markdown
# 0001 — SQLCipher with Drizzle and FTS5 (gate V1)

- **Date:** <today's date>
- **Status:** accepted

## Question

Does `better-sqlite3-multiple-ciphers` in SQLCipher mode (`cipher=sqlcipher`, `legacy=4`) work with Drizzle migrations and FTS5? (Spec §15, V1.)

## Evidence

`apps/server/src/db/db.test.ts` checks that the file header is not plain SQLite, that a wrong passphrase is refused, that Drizzle reads data back, and that an FTS5 query matches.

```
<paste the Vitest summary lines from Step 6>
```

## Decision

Use `better-sqlite3-multiple-ciphers` with Drizzle. The passphrase is the hex form of `deriveKey(masterKey, "database")`.
````

- [ ] **Step 8: Commit**

```bash
git add apps/server/drizzle.config.ts apps/server/drizzle apps/server/src/db apps/server/src/test/db.ts docs/decisions/0001-sqlcipher.md
git commit -m "feat(server): add SQLCipher database with Drizzle migrations (gate V1)"
```

---

### Task 5: Job queue and worker

**Files:**
- Create: `apps/server/src/jobs/queue.ts`, `apps/server/src/jobs/worker.ts`
- Test: `apps/server/src/jobs/queue.test.ts`, `apps/server/src/jobs/worker.test.ts`

**Interfaces:**
- Consumes: `Sqlite` from `db/index.ts`; `createTestDatabase` from `test/db.ts`.
- Produces: `type JobStatus = "queued" | "running" | "succeeded" | "failed"`; `interface JobRecord { id: number; type: string; payload: unknown; attempts: number; maxAttempts: number }`; `interface JobState { status: JobStatus; attempts: number; runAfter: number; lastError: string | null }`; `backoffMs(attempt: number): number`; `class JobQueue(sqlite: Sqlite, now?: () => number)` with `enqueue(type, payload, options?: { runAfter?: number; maxAttempts?: number }): number`, `claimNext(): JobRecord | null`, `complete(id): void`, `fail(id, error: string, permanent?: boolean): "retry" | "failed"`, `recoverStale(olderThanMs: number): number`, `get(id): JobState | null`; `type JobHandler = (job: JobRecord) => Promise<void>`; `class JobWorker(queue, handlers: ReadonlyMap<string, JobHandler>, logger: Logger, pollMs?: number)` with `runOnce(): Promise<boolean>`, `start(): void`, `stop(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/jobs/queue.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { backoffMs, JobQueue } from "./queue";

describe("JobQueue", () => {
  let t: TestDatabase;
  let now: number;
  let queue: JobQueue;

  beforeEach(() => {
    t = createTestDatabase();
    now = 1_000_000;
    queue = new JobQueue(t.sqlite, () => now);
  });
  afterEach(() => t.dispose());

  it("claims due jobs in order and leaves future ones queued", () => {
    const later = queue.enqueue("b", {}, { runAfter: now + 60_000 });
    const first = queue.enqueue("a", { n: 1 });
    expect(queue.claimNext()).toMatchObject({ id: first, type: "a", payload: { n: 1 }, attempts: 1 });
    expect(queue.claimNext()).toBeNull();
    now += 60_000;
    expect(queue.claimNext()?.id).toBe(later);
  });

  it("retries with backoff, then fails after the last attempt", () => {
    const id = queue.enqueue("a", null, { maxAttempts: 2 });
    queue.claimNext();
    expect(queue.fail(id, "boom")).toBe("retry");
    expect(queue.get(id)).toMatchObject({
      status: "queued",
      lastError: "boom",
      runAfter: now + backoffMs(1),
    });
    now += backoffMs(1);
    queue.claimNext();
    expect(queue.fail(id, "boom again")).toBe("failed");
    expect(queue.get(id)?.status).toBe("failed");
  });

  it("fails permanently when asked to", () => {
    const id = queue.enqueue("a", null);
    queue.claimNext();
    expect(queue.fail(id, "no handler", true)).toBe("failed");
  });

  it("marks completed jobs as succeeded", () => {
    const id = queue.enqueue("a", null);
    queue.claimNext();
    queue.complete(id);
    expect(queue.get(id)).toMatchObject({ status: "succeeded", lastError: null });
  });

  it("requeues jobs whose lock is stale", () => {
    const id = queue.enqueue("a", null);
    queue.claimNext();
    now += 11 * 60_000;
    expect(queue.recoverStale(10 * 60_000)).toBe(1);
    expect(queue.get(id)?.status).toBe("queued");
  });
});

describe("backoffMs", () => {
  it("grows four times per attempt and caps at one hour", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(10)).toBe(3_600_000);
  });
});
```

`apps/server/src/jobs/worker.test.ts`:

```ts
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { JobQueue } from "./queue";
import { type JobHandler, JobWorker } from "./worker";

const logger = pino({ level: "silent" });

describe("JobWorker", () => {
  let t: TestDatabase;
  let queue: JobQueue;

  beforeEach(() => {
    t = createTestDatabase();
    queue = new JobQueue(t.sqlite);
  });
  afterEach(() => t.dispose());

  it("runs the handler and completes the job", async () => {
    const seen: unknown[] = [];
    const handlers = new Map<string, JobHandler>([
      [
        "echo",
        async (job) => {
          seen.push(job.payload);
        },
      ],
    ]);
    const worker = new JobWorker(queue, handlers, logger);
    const id = queue.enqueue("echo", { hello: "world" });
    expect(await worker.runOnce()).toBe(true);
    expect(seen).toEqual([{ hello: "world" }]);
    expect(queue.get(id)?.status).toBe("succeeded");
    expect(await worker.runOnce()).toBe(false);
  });

  it("records handler errors for a retry", async () => {
    const handlers = new Map<string, JobHandler>([
      [
        "boom",
        async () => {
          throw new Error("exploded");
        },
      ],
    ]);
    const worker = new JobWorker(queue, handlers, logger);
    const id = queue.enqueue("boom", null);
    await worker.runOnce();
    expect(queue.get(id)).toMatchObject({ status: "queued", lastError: "exploded" });
  });

  it("fails jobs without a handler permanently", async () => {
    const worker = new JobWorker(queue, new Map(), logger);
    const id = queue.enqueue("unknown", null);
    await worker.runOnce();
    expect(queue.get(id)).toMatchObject({ status: "failed" });
    expect(queue.get(id)?.lastError).toContain("unknown");
  });

  it("drains the queue after start and stops cleanly", async () => {
    let count = 0;
    const handlers = new Map<string, JobHandler>([
      [
        "count",
        async () => {
          count += 1;
        },
      ],
    ]);
    const worker = new JobWorker(queue, handlers, logger, 10);
    queue.enqueue("count", null);
    queue.enqueue("count", null);
    worker.start();
    await vi.waitFor(() => expect(count).toBe(2));
    await worker.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bursar/server test src/jobs`
Expected: FAIL, `Failed to resolve import "./queue"`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/jobs/queue.ts`:

```ts
import type { Sqlite } from "../db";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  id: number;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface JobState {
  status: JobStatus;
  attempts: number;
  runAfter: number;
  lastError: string | null;
}

interface ClaimedRow {
  id: number;
  type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** (attempt - 1), 3_600_000);
}

export class JobQueue {
  constructor(
    private readonly sqlite: Sqlite,
    private readonly now: () => number = Date.now,
  ) {}

  enqueue(
    type: string,
    payload: unknown,
    options: { runAfter?: number; maxAttempts?: number } = {},
  ): number {
    const ts = this.now();
    const result = this.sqlite
      .prepare(
        `INSERT INTO jobs (type, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)`,
      )
      .run(
        type,
        JSON.stringify(payload ?? null),
        options.maxAttempts ?? 3,
        options.runAfter ?? ts,
        ts,
        ts,
      );
    return Number(result.lastInsertRowid);
  }

  claimNext(): JobRecord | null {
    const ts = this.now();
    const row = this.sqlite
      .prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ?
           ORDER BY run_after, id LIMIT 1
         )
         RETURNING id, type, payload, attempts, max_attempts`,
      )
      .get(ts, ts, ts) as ClaimedRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload),
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    };
  }

  complete(id: number): void {
    this.sqlite
      .prepare(
        `UPDATE jobs SET status = 'succeeded', locked_at = NULL, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(this.now(), id);
  }

  fail(id: number, error: string, permanent = false): "retry" | "failed" {
    const row = this.sqlite
      .prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?")
      .get(id) as { attempts: number; max_attempts: number } | undefined;
    if (!row) throw new Error(`Job ${id} not found`);
    const ts = this.now();
    if (!permanent && row.attempts < row.max_attempts) {
      this.sqlite
        .prepare(
          `UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = ?, run_after = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(error, ts + backoffMs(row.attempts), ts, id);
      return "retry";
    }
    this.sqlite
      .prepare(
        `UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(error, ts, id);
    return "failed";
  }

  recoverStale(olderThanMs: number): number {
    const ts = this.now();
    const result = this.sqlite
      .prepare(
        `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = ?
         WHERE status = 'running' AND locked_at < ?`,
      )
      .run(ts, ts - olderThanMs);
    return result.changes;
  }

  get(id: number): JobState | null {
    const row = this.sqlite
      .prepare("SELECT status, attempts, run_after, last_error FROM jobs WHERE id = ?")
      .get(id) as
      | { status: JobStatus; attempts: number; run_after: number; last_error: string | null }
      | undefined;
    if (!row) return null;
    return {
      status: row.status,
      attempts: row.attempts,
      runAfter: row.run_after,
      lastError: row.last_error,
    };
  }
}
```

`apps/server/src/jobs/worker.ts`:

```ts
import type { Logger } from "pino";
import type { JobQueue, JobRecord } from "./queue";

export type JobHandler = (job: JobRecord) => Promise<void>;

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: ReadonlyMap<string, JobHandler>,
    private readonly logger: Logger,
    private readonly pollMs = 1_000,
  ) {}

  async runOnce(): Promise<boolean> {
    const job = this.queue.claimNext();
    if (!job) return false;
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.queue.fail(job.id, `No handler registered for job type "${job.type}"`, true);
      this.logger.error({ jobId: job.id, type: job.type }, "Job has no handler");
      return true;
    }
    try {
      await handler(job);
      this.queue.complete(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = this.queue.fail(job.id, message);
      this.logger.warn({ jobId: job.id, type: job.type, outcome, error: message }, "Job failed");
    }
    return true;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.draining;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.draining = this.drain().finally(() => {
        this.draining = null;
        if (!this.stopped) this.schedule(this.pollMs);
      });
    }, delayMs);
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const ran = await this.runOnce();
      if (!ran) break;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @bursar/server test src/jobs`
Expected: `Tests  10 passed (10)`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/jobs
git commit -m "feat(server): add SQLite job queue with retries and a polling worker"
```

---

### Task 6: Scheduler

**Files:**
- Create: `apps/server/src/scheduler.ts`
- Test: `apps/server/src/scheduler.test.ts`

**Interfaces:**
- Produces: `interface ScheduledTask { name: string; run(now: Date): Promise<void> | void }`; `class Scheduler(tasks: readonly ScheduledTask[], logger: Logger, intervalMs?: number /* default 60_000 */, now?: () => Date)` with `tick(): Promise<void>` (runs every task in order, logs and swallows task errors, returns immediately if a tick is already in flight), `start(): void` (tick now, then every interval), `stop(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/scheduler.test.ts`:

```ts
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "./scheduler";

const logger = pino({ level: "silent" });

describe("Scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks immediately on start and then every interval until stopped", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const scheduler = new Scheduler([{ name: "count", run: () => void (runs += 1) }], logger, 60_000);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(2);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(2);
  });

  it("keeps running the other tasks when one throws", async () => {
    let ran = false;
    const scheduler = new Scheduler(
      [
        {
          name: "broken",
          run: () => {
            throw new Error("nope");
          },
        },
        { name: "healthy", run: () => void (ran = true) },
      ],
      logger,
    );
    await scheduler.tick();
    expect(ran).toBe(true);
  });

  it("skips a tick while the previous one is still running", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const scheduler = new Scheduler(
      [
        {
          name: "slow",
          run: () => {
            calls += 1;
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        },
      ],
      logger,
    );
    const first = scheduler.tick();
    await scheduler.tick();
    expect(calls).toBe(1);
    release();
    await first;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bursar/server test src/scheduler.test.ts`
Expected: FAIL, `Failed to resolve import "./scheduler"`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/scheduler.ts`:

```ts
import type { Logger } from "pino";

export interface ScheduledTask {
  name: string;
  run(now: Date): Promise<void> | void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly tasks: readonly ScheduledTask[],
    private readonly logger: Logger,
    private readonly intervalMs = 60_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = this.runAll();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  private async runAll(): Promise<void> {
    for (const task of this.tasks) {
      try {
        await task.run(this.now());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error({ task: task.name, error: message }, "Scheduled task failed");
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @bursar/server test src/scheduler.test.ts`
Expected: `Tests  3 passed (3)`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/scheduler.ts apps/server/src/scheduler.test.ts
git commit -m "feat(server): add interval scheduler with overlap protection"
```

---

### Task 7: HTTP application, Origin check, Cloudflare Access guard, panel serving

**Files:**
- Create: `apps/server/src/http/app.ts`, `apps/server/src/http/origin.ts`, `apps/server/src/http/access.ts`, `apps/server/src/http/static.ts`
- Test: `apps/server/src/http/app.test.ts`, `apps/server/src/http/access.test.ts`, `apps/server/src/http/static.test.ts`

**Interfaces:**
- Consumes: `Config` from `config.ts`.
- Produces: `type AppEnv = { Variables: { sessionId: number } }`; `interface AppDeps { config: Pick<Config, "publicUrl" | "cfAccess" | "webDistDir">; logger: Logger; healthCheck: () => boolean; accessKeys?: JWTVerifyGetKey }`; `createApp(deps: AppDeps): Hono<AppEnv>`; `originCheck(publicUrl: URL): MiddlewareHandler`; `accessGuard(options: { teamDomain: string; audience: string; getKey?: JWTVerifyGetKey }): MiddlewareHandler`; `webAppHandler(webDistDir: string): Handler` (serves files under the directory and falls back to `index.html`).

- [ ] **Step 1: Write the failing tests**

`apps/server/src/http/access.test.ts`:

```ts
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { accessGuard } from "./access";

const TEAM = "team.example.test";
const ISSUER = `https://${TEAM}`;
const AUDIENCE = "test-audience";

async function setupKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
  const sign = (claims: { audience?: string; issuer?: string; exp?: number | string } = {}) =>
    new SignJWT({ email: "owner@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(claims.issuer ?? ISSUER)
      .setAudience(claims.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "5m")
      .sign(privateKey);
  return { getKey: createLocalJWKSet({ keys: [jwk] }), sign };
}

function appWith(getKey: ReturnType<typeof createLocalJWKSet>) {
  const app = new Hono();
  app.use("*", accessGuard({ teamDomain: TEAM, audience: AUDIENCE, getKey }));
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/api/thing", (c) => c.text("thing"));
  return app;
}

const withToken = (token: string) => ({ headers: { "cf-access-jwt-assertion": token } });

describe("accessGuard", () => {
  it("rejects requests without a token", async () => {
    const { getKey } = await setupKeys();
    expect((await appWith(getKey).request("/api/thing")).status).toBe(403);
  });

  it("accepts a valid token", async () => {
    const { getKey, sign } = await setupKeys();
    const res = await appWith(getKey).request("/api/thing", withToken(await sign()));
    expect(res.status).toBe(200);
  });

  it("rejects a token for another audience or issuer", async () => {
    const { getKey, sign } = await setupKeys();
    const app = appWith(getKey);
    expect((await app.request("/api/thing", withToken(await sign({ audience: "x" })))).status).toBe(
      403,
    );
    expect(
      (await app.request("/api/thing", withToken(await sign({ issuer: "https://evil.test" }))))
        .status,
    ).toBe(403);
  });

  it("rejects an expired token", async () => {
    const { getKey, sign } = await setupKeys();
    const expired = await sign({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await appWith(getKey).request("/api/thing", withToken(expired))).status).toBe(403);
  });

  it("lets the health check through without a token", async () => {
    const { getKey } = await setupKeys();
    expect((await appWith(getKey).request("/healthz")).status).toBe(200);
  });
});
```

`apps/server/src/http/app.test.ts`:

```ts
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const ORIGIN = "https://bursar.example.test";
const config = { publicUrl: new URL(ORIGIN), cfAccess: null, webDistDir: null };
const logger = pino({ level: "silent" });

describe("createApp", () => {
  it("reports health", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 503 when the health check fails", async () => {
    const app = createApp({ config, logger, healthCheck: () => false });
    expect((await app.request("/healthz")).status).toBe(503);
  });

  it("sets a strict content security policy", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/healthz");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("rejects mutating API requests without the panel's origin", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const post = (headers: Record<string, string>) =>
      app.request("/api/nope", { method: "POST", headers });
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: ORIGIN })).status).toBe(404);
  });
});
```

`apps/server/src/http/static.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

describe("panel serving", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-web-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>panel</title>");
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    app = createApp({
      config: { publicUrl: new URL("https://bursar.example.test"), cfAccess: null, webDistDir: dir },
      logger: pino({ level: "silent" }),
      healthCheck: () => true,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("serves index.html at the root and for client-side routes", async () => {
    for (const route of ["/", "/accounts/123"]) {
      const res = await app.request(route);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>panel</title>");
    }
  });

  it("serves hashed assets with long-lived caching", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("console.log(1)");
  });

  it("never serves files outside the build directory", async () => {
    const res = await app.request("/..%2f..%2f..%2fetc%2fpasswd");
    expect(await res.text()).toContain("<title>panel</title>");
  });

  it("keeps API 404s as JSON", async () => {
    expect((await app.request("/api/unknown")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bursar/server test src/http`
Expected: FAIL, `Failed to resolve import "./access"` (and `./app`).

- [ ] **Step 3: Write the implementation**

`apps/server/src/http/origin.ts`:

```ts
import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function originCheck(publicUrl: URL): MiddlewareHandler {
  const expected = publicUrl.origin;
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && c.req.header("origin") !== expected) {
      return c.json({ error: "Cross-origin request rejected" }, 403);
    }
    await next();
  };
}
```

`apps/server/src/http/access.ts`:

```ts
import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export function accessGuard(options: {
  teamDomain: string;
  audience: string;
  getKey?: JWTVerifyGetKey;
}): MiddlewareHandler {
  const issuer = `https://${options.teamDomain}`;
  const getKey = options.getKey ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (c, next) => {
    if (c.req.path === "/healthz") return next();
    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) return c.json({ error: "Missing Cloudflare Access token" }, 403);
    try {
      await jwtVerify(token, getKey, { issuer, audience: options.audience });
    } catch {
      return c.json({ error: "Invalid Cloudflare Access token" }, 403);
    }
    await next();
  };
}
```

`apps/server/src/http/static.ts`:

```ts
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Handler } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function resolveInside(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const relative = path.normalize(decoded).replace(/^[/\\]+/, "");
  if (!relative) return null;
  const file = path.join(root, relative);
  if (!file.startsWith(root + path.sep)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

export function webAppHandler(webDistDir: string): Handler {
  const root = path.resolve(webDistDir);
  const indexFile = path.join(root, "index.html");
  if (!existsSync(indexFile)) throw new Error(`Web build not found: ${indexFile}`);
  const indexHtml = readFileSync(indexFile, "utf8");

  return (c) => {
    const file = resolveInside(root, c.req.path);
    if (!file) return c.html(indexHtml, 200, { "cache-control": "no-cache" });
    const isAsset = path.relative(root, file).startsWith(`assets${path.sep}`);
    return c.body(readFileSync(file), 200, {
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
  };
}
```

`apps/server/src/http/app.ts`:

```ts
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { JWTVerifyGetKey } from "jose";
import type { Logger } from "pino";
import type { Config } from "../config";
import { accessGuard } from "./access";
import { originCheck } from "./origin";
import { webAppHandler } from "./static";

export type AppEnv = { Variables: { sessionId: number } };

export interface AppDeps {
  config: Pick<Config, "publicUrl" | "cfAccess" | "webDistDir">;
  logger: Logger;
  healthCheck: () => boolean;
  accessKeys?: JWTVerifyGetKey;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    deps.logger.debug(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      "request",
    );
  });

  if (deps.config.cfAccess) {
    app.use("*", accessGuard({ ...deps.config.cfAccess, getKey: deps.accessKeys }));
  }

  app.get("/healthz", (c) =>
    deps.healthCheck() ? c.json({ ok: true }) : c.json({ ok: false }, 503),
  );

  app.use("/api/*", originCheck(deps.config.publicUrl));
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (deps.config.webDistDir) {
    app.get("*", webAppHandler(deps.config.webDistDir));
  }

  app.onError((error, c) => {
    deps.logger.error({ error: error.message, stack: error.stack }, "Unhandled error");
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @bursar/server test src/http && pnpm --filter @bursar/server typecheck`
Expected: `Tests  14 passed (14)`; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http
git commit -m "feat(server): add HTTP app with CSP, origin check, Access guard and panel serving"
```

---

### Task 8: Authentication primitives

**Files:**
- Create: `apps/server/src/auth/passwords.ts`, `apps/server/src/auth/totp.ts`, `apps/server/src/auth/owner.ts`, `apps/server/src/auth/sessions.ts`, `apps/server/src/auth/setup-code.ts`, `apps/server/src/auth/rate-limit.ts`
- Test: one `*.test.ts` next to each file

**Interfaces:**
- Consumes: `BursarDb`, `owner`, `authSessions` (Task 4); `seal`, `unseal` (Task 3); `createTestDatabase` (Task 4).
- Produces:
  - `hashPassword(password: string): Promise<string>` (argon2id); `verifyPassword(hash: string, password: string): Promise<boolean>` (false on malformed hash).
  - `TOTP_PERIOD_SECONDS = 30`; `createTotpSetup(label: string): { secret: string; uri: string }`; `verifyTotp(secret: string, code: string, lastUsedStep: number, nowMs: number): { ok: true; step: number } | { ok: false }` (window ±1, rejects steps ≤ `lastUsedStep`); `generateTotpCode(secret: string, nowMs: number): string`.
  - `interface OwnerRecord { passwordHash: string; totpSecret: string; lastTotpStep: number }`; `class OwnerStore(db: BursarDb, totpKey: Buffer)` with `exists(): boolean`, `get(): OwnerRecord | null`, `create(record: OwnerRecord, now: Date): void` (throws if an owner exists), `setLastTotpStep(step: number): void`.
  - `SESSION_IDLE_MS = 7 days`; `class SessionStore(db: BursarDb, now?: () => number)` with `create(userAgent: string | null): string` (returns the raw token), `validate(token: string): number | null` (session id; slides expiry at most once per minute), `revoke(token: string): void`, `purgeExpired(): number`.
  - `class SetupCode(filePath: string)` with `issue(): void` (writes a new code to the file, mode 600), `verify(candidate: string): boolean` (constant time), `clear(): void` (forgets the code, deletes the file).
  - `class FailureLimiter(maxFailures = 5, windowMs = 15 min, now?: () => number)` with `isBlocked(key)`, `recordFailure(key)`, `reset(key)`.

- [ ] **Step 1: Write the failing tests**

`apps/server/src/auth/passwords.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords";

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "wrong password")).toBe(false);
  });

  it("returns false for a malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});
```

`apps/server/src/auth/totp.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTotpSetup, generateTotpCode, TOTP_PERIOD_SECONDS, verifyTotp } from "./totp";

const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
const STEP = Math.floor(NOW / 1000 / TOTP_PERIOD_SECONDS);

describe("totp", () => {
  it("accepts the current code and returns its time step", () => {
    const { secret } = createTotpSetup("owner");
    expect(verifyTotp(secret, generateTotpCode(secret, NOW), 0, NOW)).toEqual({
      ok: true,
      step: STEP,
    });
  });

  it("accepts a code from the previous window", () => {
    const { secret } = createTotpSetup("owner");
    const previous = generateTotpCode(secret, NOW - TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotp(secret, previous, 0, NOW)).toEqual({ ok: true, step: STEP - 1 });
  });

  it("rejects a code whose step was already used", () => {
    const { secret } = createTotpSetup("owner");
    expect(verifyTotp(secret, generateTotpCode(secret, NOW), STEP, NOW)).toEqual({ ok: false });
  });

  it("rejects a wrong code", () => {
    const { secret } = createTotpSetup("owner");
    const code = generateTotpCode(secret, NOW);
    const wrong = code === "000000" ? "111111" : "000000";
    expect(verifyTotp(secret, wrong, 0, NOW)).toEqual({ ok: false });
  });

  it("builds an otpauth URI for authenticator apps", () => {
    const { uri, secret } = createTotpSetup("owner");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("issuer=Bursar");
  });
});
```

`apps/server/src/auth/owner.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { owner } from "../db/schema";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { OwnerStore } from "./owner";

const KEY = Buffer.alloc(32, 1);
const RECORD = { passwordHash: "$argon2id$x", totpSecret: "JBSWY3DPEHPK3PXP", lastTotpStep: 5 };

describe("OwnerStore", () => {
  let t: TestDatabase;
  let store: OwnerStore;

  beforeEach(() => {
    t = createTestDatabase();
    store = new OwnerStore(t.db, KEY);
  });
  afterEach(() => t.dispose());

  it("creates the owner and reads it back with the TOTP secret decrypted", () => {
    expect(store.exists()).toBe(false);
    store.create(RECORD, new Date(0));
    expect(store.exists()).toBe(true);
    expect(store.get()).toEqual(RECORD);
  });

  it("stores the TOTP secret encrypted", () => {
    store.create(RECORD, new Date(0));
    const row = t.db.select().from(owner).get();
    expect(row?.totpSecretEnc.toString("utf8")).not.toContain(RECORD.totpSecret);
  });

  it("updates the last used TOTP step", () => {
    store.create(RECORD, new Date(0));
    store.setLastTotpStep(42);
    expect(store.get()?.lastTotpStep).toBe(42);
  });

  it("refuses a second owner", () => {
    store.create(RECORD, new Date(0));
    expect(() => store.create(RECORD, new Date(0))).toThrow();
  });
});
```

`apps/server/src/auth/sessions.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { SESSION_IDLE_MS, SessionStore } from "./sessions";

const DAY = 24 * 60 * 60 * 1000;

describe("SessionStore", () => {
  let t: TestDatabase;
  let now: number;
  let store: SessionStore;

  beforeEach(() => {
    t = createTestDatabase();
    now = Date.UTC(2026, 10, 9);
    store = new SessionStore(t.db, () => now);
  });
  afterEach(() => t.dispose());

  it("validates a fresh token and rejects unknown ones", () => {
    const token = store.create("test-agent");
    expect(store.validate(token)).toBeTypeOf("number");
    expect(store.validate("unknown")).toBeNull();
  });

  it("slides the expiry while the session is used", () => {
    const token = store.create(null);
    now += 6 * DAY;
    expect(store.validate(token)).not.toBeNull();
    now += 6 * DAY;
    expect(store.validate(token)).not.toBeNull();
  });

  it("expires after the idle period", () => {
    const token = store.create(null);
    now += SESSION_IDLE_MS + 1;
    expect(store.validate(token)).toBeNull();
  });

  it("revokes a token", () => {
    const token = store.create(null);
    store.revoke(token);
    expect(store.validate(token)).toBeNull();
  });

  it("purges expired sessions", () => {
    store.create(null);
    now += SESSION_IDLE_MS + 1;
    expect(store.purgeExpired()).toBe(1);
  });
});
```

`apps/server/src/auth/setup-code.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupCode } from "./setup-code";

describe("SetupCode", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-setup-"));
    file = path.join(dir, "setup-code");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the code to a private file and verifies it", () => {
    const setup = new SetupCode(file);
    setup.issue();
    const code = readFileSync(file, "utf8").trim();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(setup.verify(code)).toBe(true);
    expect(setup.verify(` ${code}\n`)).toBe(true);
    expect(setup.verify("wrong")).toBe(false);
  });

  it("forgets the code and removes the file when cleared", () => {
    const setup = new SetupCode(file);
    setup.issue();
    const code = readFileSync(file, "utf8").trim();
    setup.clear();
    expect(existsSync(file)).toBe(false);
    expect(setup.verify(code)).toBe(false);
  });
});
```

`apps/server/src/auth/rate-limit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FailureLimiter } from "./rate-limit";

describe("FailureLimiter", () => {
  it("blocks a key after the maximum failures within the window", () => {
    let now = 0;
    const limiter = new FailureLimiter(3, 1_000, () => now);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(true);
    expect(limiter.isBlocked("other")).toBe(false);
    now = 1_000;
    expect(limiter.isBlocked("ip")).toBe(false);
  });

  it("forgets failures on reset", () => {
    const limiter = new FailureLimiter(1, 1_000, () => 0);
    limiter.recordFailure("ip");
    limiter.reset("ip");
    expect(limiter.isBlocked("ip")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bursar/server test src/auth`
Expected: FAIL, unresolved imports for every module under `src/auth`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/auth/passwords.ts`:

```ts
import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
```

`apps/server/src/auth/totp.ts`:

```ts
import { Secret, TOTP } from "otpauth";

export const TOTP_PERIOD_SECONDS = 30;

function buildTotp(secret: Secret, label = "owner"): TOTP {
  return new TOTP({
    issuer: "Bursar",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret,
  });
}

export function createTotpSetup(label: string): { secret: string; uri: string } {
  const secret = new Secret({ size: 20 });
  return { secret: secret.base32, uri: buildTotp(secret, label).toString() };
}

export function verifyTotp(
  secret: string,
  code: string,
  lastUsedStep: number,
  nowMs: number,
): { ok: true; step: number } | { ok: false } {
  const delta = buildTotp(Secret.fromBase32(secret)).validate({
    token: code,
    timestamp: nowMs,
    window: 1,
  });
  if (delta === null) return { ok: false };
  const step = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS) + delta;
  if (step <= lastUsedStep) return { ok: false };
  return { ok: true, step };
}

export function generateTotpCode(secret: string, nowMs: number): string {
  return buildTotp(Secret.fromBase32(secret)).generate({ timestamp: nowMs });
}
```

`apps/server/src/auth/owner.ts`:

```ts
import { eq } from "drizzle-orm";
import { seal, unseal } from "../crypto";
import type { BursarDb } from "../db";
import { owner } from "../db/schema";

const OWNER_ID = 1;

export interface OwnerRecord {
  passwordHash: string;
  totpSecret: string;
  lastTotpStep: number;
}

export class OwnerStore {
  constructor(
    private readonly db: BursarDb,
    private readonly totpKey: Buffer,
  ) {}

  exists(): boolean {
    return this.db.select({ id: owner.id }).from(owner).get() !== undefined;
  }

  get(): OwnerRecord | null {
    const row = this.db.select().from(owner).where(eq(owner.id, OWNER_ID)).get();
    if (!row) return null;
    return {
      passwordHash: row.passwordHash,
      totpSecret: unseal(this.totpKey, row.totpSecretEnc).toString("utf8"),
      lastTotpStep: row.lastTotpStep,
    };
  }

  create(record: OwnerRecord, now: Date): void {
    this.db
      .insert(owner)
      .values({
        id: OWNER_ID,
        passwordHash: record.passwordHash,
        totpSecretEnc: seal(this.totpKey, Buffer.from(record.totpSecret, "utf8")),
        lastTotpStep: record.lastTotpStep,
        createdAt: now,
      })
      .run();
  }

  setLastTotpStep(step: number): void {
    this.db.update(owner).set({ lastTotpStep: step }).where(eq(owner.id, OWNER_ID)).run();
  }
}
```

`apps/server/src/auth/sessions.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import type { BursarDb } from "../db";
import { authSessions } from "../db/schema";

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60_000;

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export class SessionStore {
  constructor(
    private readonly db: BursarDb,
    private readonly now: () => number = Date.now,
  ) {}

  create(userAgent: string | null): string {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db
      .insert(authSessions)
      .values({
        tokenHash: hashToken(token),
        createdAt: new Date(now),
        lastSeenAt: new Date(now),
        expiresAt: new Date(now + SESSION_IDLE_MS),
        userAgent: userAgent?.slice(0, 256) ?? null,
      })
      .run();
    return token;
  }

  validate(token: string): number | null {
    const now = this.now();
    const row = this.db
      .select()
      .from(authSessions)
      .where(
        and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, new Date(now))),
      )
      .get();
    if (!row) return null;
    if (now - row.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      this.db
        .update(authSessions)
        .set({ lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_IDLE_MS) })
        .where(eq(authSessions.id, row.id))
        .run();
    }
    return row.id;
  }

  revoke(token: string): void {
    this.db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token))).run();
  }

  purgeExpired(): number {
    return this.db
      .delete(authSessions)
      .where(lte(authSessions.expiresAt, new Date(this.now())))
      .run().changes;
  }
}
```

`apps/server/src/auth/setup-code.ts`:

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export class SetupCode {
  private code: string | null = null;

  constructor(private readonly filePath: string) {}

  issue(): void {
    this.code = randomBytes(18).toString("base64url");
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${this.code}\n`, { mode: 0o600 });
    chmodSync(this.filePath, 0o600);
  }

  verify(candidate: string): boolean {
    if (!this.code) return false;
    const given = Buffer.from(candidate.trim());
    const expected = Buffer.from(this.code);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  clear(): void {
    this.code = null;
    rmSync(this.filePath, { force: true });
  }
}
```

`apps/server/src/auth/rate-limit.ts`:

```ts
interface Window {
  count: number;
  startedAt: number;
}

export class FailureLimiter {
  private readonly failures = new Map<string, Window>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.current(key);
    return entry !== undefined && entry.count >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const entry = this.current(key);
    if (entry) entry.count += 1;
    else this.failures.set(key, { count: 1, startedAt: this.now() });
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private current(key: string): Window | undefined {
    const entry = this.failures.get(key);
    if (entry && this.now() - entry.startedAt >= this.windowMs) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @bursar/server test src/auth && pnpm --filter @bursar/server typecheck`
Expected: `Tests  20 passed (20)`; `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth
git commit -m "feat(server): add password, TOTP, owner, session, setup-code and rate-limit primitives"
```

---

### Task 9: Authentication routes and session middleware

**Files:**
- Create: `apps/server/src/auth/routes.ts`
- Modify: `apps/server/src/http/app.ts` (add optional `auth` dependency, mount routes and session middleware, add `GET /api/me`)
- Test: `apps/server/src/auth/routes.test.ts`

**Interfaces:**
- Consumes: everything from Task 8; `createApp`, `AppEnv`, `AppDeps` from Task 7; schemas from `@bursar/shared`.
- Produces: `SESSION_COOKIE = "bursar_session"`; `interface AuthDeps { owners: OwnerStore; sessions: SessionStore; setupCode: SetupCode; limiter: FailureLimiter; secureCookies: boolean; now: () => number; getClientIp: (c: Context) => string }`; `authRoutes(deps: AuthDeps): Hono<AppEnv>` mounted at `/api/auth` with `GET /status`, `POST /setup/start`, `POST /setup/confirm`, `POST /login`, `POST /logout`; `requireSession(sessions: SessionStore): MiddlewareHandler<AppEnv>` (skips `/api/auth/*`); `AppDeps.auth?: AuthDeps`; protected `GET /api/me` → `{ authenticated: true }`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/auth/routes.test.ts`:

```ts
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
    const auth: AuthDeps = {
      owners: new OwnerStore(t.db, Buffer.alloc(32, 1)),
      sessions: new SessionStore(t.db, () => now),
      setupCode,
      limiter: new FailureLimiter(5, 15 * 60_000, () => now),
      secureCookies: true,
      now: () => now,
      getClientIp: () => "203.0.113.7",
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
    expect((await post("/api/auth/setup/start", { setupCode: code, password: "short" })).status).toBe(
      400,
    );
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
    expect((await post("/api/auth/setup/start", { setupCode: code, password: PASSWORD })).status).toBe(
      409,
    );
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

  it("revokes the session on logout", async () => {
    const { cookie } = await completeSetup();
    expect((await post("/api/auth/logout", {}, cookie)).status).toBe(200);
    expect((await get("/api/me", cookie)).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bursar/server test src/auth/routes.test.ts`
Expected: FAIL, `Failed to resolve import "./routes"`.

- [ ] **Step 3: Write the routes**

`apps/server/src/auth/routes.ts`:

```ts
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
    if (deps.limiter.isBlocked(ip)) return c.json({ error: "Too many attempts" }, 429);
    const parsed = setupStartRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    if (!deps.setupCode.verify(parsed.data.setupCode)) {
      deps.limiter.recordFailure(ip);
      return c.json({ error: "Invalid setup code" }, 401);
    }
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
    if (deps.limiter.isBlocked(ip)) return c.json({ error: "Too many attempts" }, 429);
    const parsed = loginRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const record = deps.owners.get();
    if (!record) return c.json({ error: "Setup required" }, 409);
    const passwordOk = await verifyPassword(record.passwordHash, parsed.data.password);
    const totp = verifyTotp(record.totpSecret, parsed.data.code, record.lastTotpStep, deps.now());
    if (!passwordOk || !totp.ok) {
      deps.limiter.recordFailure(ip);
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
```

- [ ] **Step 4: Mount the routes in the app**

In `apps/server/src/http/app.ts`, add the import:

```ts
import { type AuthDeps, authRoutes, requireSession } from "../auth/routes";
```

Add the field to `AppDeps`:

```ts
  auth?: AuthDeps;
```

Replace the two lines:

```ts
  app.use("/api/*", originCheck(deps.config.publicUrl));
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
```

with:

```ts
  app.use("/api/*", originCheck(deps.config.publicUrl));
  if (deps.auth) {
    app.route("/api/auth", authRoutes(deps.auth));
    app.use("/api/*", requireSession(deps.auth.sessions));
    app.get("/api/me", (c) => c.json({ authenticated: true }));
  }
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
```

- [ ] **Step 5: Run the whole server suite and typecheck**

Run: `pnpm --filter @bursar/server test && pnpm --filter @bursar/server typecheck`
Expected: every test file passes (summary `Tests  76 passed (76)` or the current total, 0 failed); `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/auth/routes.ts apps/server/src/auth/routes.test.ts apps/server/src/http/app.ts
git commit -m "feat(server): add owner setup, login, logout and session middleware"
```

---

### Task 10: Logger, maintenance task, server wiring, entrypoint and `bursar init`

**Files:**
- Create: `apps/server/src/logger.ts`, `apps/server/src/maintenance.ts`, `apps/server/src/server.ts`, `apps/server/src/index.ts`, `apps/server/src/cli.ts`, `apps/server/tsup.config.ts`, `apps/server/.env.example`
- Test: `apps/server/src/logger.test.ts`, `apps/server/src/maintenance.test.ts`, `apps/server/src/server.test.ts`, `apps/server/src/cli.test.ts`

**Interfaces:**
- Consumes: all earlier server modules.
- Produces: `createLogger(level: Config["logLevel"], destination?: DestinationStream): Logger` (redacts `password`, `token`, `setupCode`, `secret`, cookie, authorization and Access JWT headers); `maintenanceTask(queue: JobQueue, sessions: SessionStore, logger: Logger): ScheduledTask` (requeues jobs locked > 10 min, purges expired sessions); `interface RunningBursar { port: number; close(): Promise<void> }`; `startBursar(config: Config, logger: Logger): Promise<RunningBursar>`; `initCommand(args: string[], log?: (line: string) => void): number` (exit code: 0 ok, 1 refuses overwrite, 2 usage).

- [ ] **Step 1: Write the failing tests**

`apps/server/src/logger.test.ts`:

```ts
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

describe("createLogger", () => {
  it("redacts secrets at the top level and one level deep", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger("info", sink);
    logger.info(
      { password: "hunter2-secret", nested: { token: "tok-secret" }, keep: "visible" },
      "test",
    );
    const output = lines.join("");
    expect(output).not.toContain("hunter2-secret");
    expect(output).not.toContain("tok-secret");
    expect(output).toContain("visible");
    expect(output).toContain("[redacted]");
  });
});
```

`apps/server/src/maintenance.test.ts`:

```ts
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_IDLE_MS, SessionStore } from "./auth/sessions";
import { JobQueue } from "./jobs/queue";
import { maintenanceTask } from "./maintenance";
import { createTestDatabase, type TestDatabase } from "./test/db";

describe("maintenanceTask", () => {
  let t: TestDatabase;
  afterEach(() => t.dispose());
  beforeEach(() => {
    t = createTestDatabase();
  });

  it("requeues stale jobs and purges expired sessions", async () => {
    let now = Date.UTC(2026, 10, 9);
    const queue = new JobQueue(t.sqlite, () => now);
    const sessions = new SessionStore(t.db, () => now);
    const id = queue.enqueue("x", null);
    queue.claimNext();
    const token = sessions.create(null);
    now += SESSION_IDLE_MS + 1;
    await maintenanceTask(queue, sessions, pino({ level: "silent" })).run(new Date(now));
    expect(queue.get(id)?.status).toBe("queued");
    expect(sessions.validate(token)).toBeNull();
    expect(sessions.purgeExpired()).toBe(0);
  });
});
```

`apps/server/src/cli.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand } from "./cli";

describe("bursar init", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a 32-byte base64 key to a private file without printing it", () => {
    const file = path.join(dir, "master_key");
    const printed: string[] = [];
    expect(initCommand(["--out", file], (line) => printed.push(line))).toBe(0);
    const key = readFileSync(file, "utf8").trim();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(printed.join("\n")).not.toContain(key);
  });

  it("refuses to overwrite an existing key", () => {
    const file = path.join(dir, "master_key");
    initCommand(["--out", file], () => {});
    expect(initCommand(["--out", file], () => {})).toBe(1);
  });

  it("requires --out", () => {
    expect(initCommand([], () => {})).toBe(2);
  });
});
```

`apps/server/src/server.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bursar/server test src/logger.test.ts src/maintenance.test.ts src/cli.test.ts src/server.test.ts`
Expected: FAIL, unresolved imports `./logger`, `./maintenance`, `./cli`, `./server`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/logger.ts`:

```ts
import { type DestinationStream, type Logger, pino } from "pino";
import type { Config } from "./config";

const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "setupCode",
  "*.setupCode",
  "secret",
  "*.secret",
  "headers.cookie",
  "*.headers.cookie",
  "headers.authorization",
  "*.headers.authorization",
  'headers["cf-access-jwt-assertion"]',
  '*.headers["cf-access-jwt-assertion"]',
];

export function createLogger(level: Config["logLevel"], destination?: DestinationStream): Logger {
  const options = { level, redact: { paths: REDACT_PATHS, censor: "[redacted]" } };
  return destination ? pino(options, destination) : pino(options);
}
```

`apps/server/src/maintenance.ts`:

```ts
import type { Logger } from "pino";
import type { SessionStore } from "./auth/sessions";
import type { JobQueue } from "./jobs/queue";
import type { ScheduledTask } from "./scheduler";

const STALE_JOB_MS = 10 * 60_000;

export function maintenanceTask(
  queue: JobQueue,
  sessions: SessionStore,
  logger: Logger,
): ScheduledTask {
  return {
    name: "maintenance",
    run: () => {
      const requeued = queue.recoverStale(STALE_JOB_MS);
      const purged = sessions.purgeExpired();
      if (requeued > 0 || purged > 0) logger.info({ requeued, purged }, "Maintenance done");
    },
  };
}
```

`apps/server/src/server.ts`:

```ts
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Logger } from "pino";
import { OwnerStore } from "./auth/owner";
import { FailureLimiter } from "./auth/rate-limit";
import { SessionStore } from "./auth/sessions";
import { SetupCode } from "./auth/setup-code";
import type { Config } from "./config";
import { deriveKey } from "./crypto";
import { openDatabase, runMigrations } from "./db";
import { createApp } from "./http/app";
import { JobQueue } from "./jobs/queue";
import { type JobHandler, JobWorker } from "./jobs/worker";
import { maintenanceTask } from "./maintenance";
import { Scheduler } from "./scheduler";

export interface RunningBursar {
  port: number;
  close(): Promise<void>;
}

export async function startBursar(config: Config, logger: Logger): Promise<RunningBursar> {
  mkdirSync(config.dataDir, { recursive: true });
  const database = openDatabase(
    path.join(config.dataDir, "bursar.db"),
    deriveKey(config.masterKey, "database").toString("hex"),
  );
  runMigrations(database.db, config.migrationsDir);

  const owners = new OwnerStore(database.db, deriveKey(config.masterKey, "totp"));
  const sessions = new SessionStore(database.db);
  const setupCodeFile = path.join(config.dataDir, "setup-code");
  const setupCode = new SetupCode(setupCodeFile);
  if (!owners.exists()) {
    setupCode.issue();
    logger.warn({ file: setupCodeFile }, "No owner yet: open the panel and enter the setup code");
  }

  const queue = new JobQueue(database.sqlite);
  const worker = new JobWorker(queue, new Map<string, JobHandler>(), logger);
  const scheduler = new Scheduler([maintenanceTask(queue, sessions, logger)], logger);

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
      limiter: new FailureLimiter(),
      secureCookies: config.publicUrl.protocol === "https:",
      now: Date.now,
      getClientIp: (c) =>
        (config.cfAccess ? c.req.header("cf-connecting-ip") : undefined) ??
        getConnInfo(c).remote.address ??
        "unknown",
    },
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  worker.start();
  scheduler.start();

  return {
    port,
    close: async () => {
      await scheduler.stop();
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}
```

`apps/server/src/index.ts`:

```ts
import { ConfigError, loadConfig } from "./config";
import { createLogger } from "./logger";
import { startBursar } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
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
```

`apps/server/src/cli.ts`:

```ts
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { generateMasterKey } from "./crypto";

const USAGE = "Usage: bursar init --out <path>";

export function initCommand(args: string[], log: (line: string) => void = console.log): number {
  const index = args.indexOf("--out");
  const target = index >= 0 ? args[index + 1] : undefined;
  if (!target) {
    log(USAGE);
    return 2;
  }
  try {
    writeFileSync(target, `${generateMasterKey()}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      log(`Refusing to overwrite an existing file: ${target}`);
      return 1;
    }
    throw error;
  }
  log(`Master key written to ${target} (mode 600).`);
  log("Keep an offline copy of this file: without it the data cannot be decrypted.");
  return 0;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "init") return initCommand(rest);
  console.error(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
```

`apps/server/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: [/^@bursar\//],
});
```

`apps/server/.env.example`:

```
# Local development. Copy to apps/server/.env (gitignored).
# The panel dev server runs on port 5173 and proxies /api here, so the public URL is the Vite origin.
BURSAR_PUBLIC_URL=http://localhost:5173
TZ=Europe/Rome
BURSAR_HOST=127.0.0.1
BURSAR_PORT=8080
BURSAR_DATA_DIR=./data
BURSAR_MASTER_KEY_FILE=./data/master_key
BURSAR_LOG_LEVEL=debug
```

- [ ] **Step 4: Run the server suite, typecheck and build**

Run: `pnpm --filter @bursar/server test && pnpm --filter @bursar/server typecheck && pnpm --filter @bursar/server build && ls apps/server/dist`
Expected: all test files pass with 0 failed; `tsc` exits 0; `dist/` contains `index.js` and `cli.js`.

- [ ] **Step 5: Check the CLI from the built output**

Run (scratch directory, not the repo):

```bash
SCRATCH="$(mktemp -d)"
node apps/server/dist/cli.js init --out "$SCRATCH/master_key" && stat -f '%Lp' "$SCRATCH/master_key"
```

Expected: the two lines printed by `initCommand`, then `600`. The key itself is never printed. Remove the scratch file afterwards with `rm "$SCRATCH/master_key" && rmdir "$SCRATCH"`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/logger.ts apps/server/src/logger.test.ts apps/server/src/maintenance.ts apps/server/src/maintenance.test.ts apps/server/src/server.ts apps/server/src/server.test.ts apps/server/src/index.ts apps/server/src/cli.ts apps/server/src/cli.test.ts apps/server/tsup.config.ts apps/server/.env.example
git commit -m "feat(server): wire the service entrypoint, maintenance task and bursar init"
```

---

### Task 11: Panel shell (setup, login, home) with i18n

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/styles.css`, `apps/web/src/i18n/index.ts`, `apps/web/src/i18n/en.json`, `apps/web/src/i18n/it.json`, `apps/web/src/components/ui.tsx`, `apps/web/src/components/LanguageSwitcher.tsx`, `apps/web/src/pages/SetupPage.tsx`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/HomePage.tsx`, `apps/web/src/test/setup.ts`
- Test: `apps/web/src/i18n/i18n.test.ts`, `apps/web/src/pages/LoginPage.test.tsx`

**Interfaces:**
- Consumes: types and `PASSWORD_MIN_LENGTH` from `@bursar/shared`; server routes from Task 9.
- Produces: `class ApiError(status: number, message: string)`; `AUTH_STATUS_KEY = ["auth-status"]`; `api.status() / setupStart(body) / setupConfirm(body) / login(body) / logout()`; `setLanguage(language: "it" | "en")`. Routing with TanStack Router is introduced in M1, when the panel gets more than one authenticated page.

- [ ] **Step 1: Write the package files**

`apps/web/package.json`:

```json
{
  "name": "@bursar/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p ."
  },
  "dependencies": {
    "@bursar/shared": "workspace:*",
    "@tanstack/react-query": "^5.107.1",
    "i18next": "^27.0.1",
    "qrcode": "^1.5.4",
    "react": "^19.3.1",
    "react-dom": "^19.3.1",
    "react-i18next": "^18.0.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.5",
    "@testing-library/react": "^16.3.3",
    "@types/qrcode": "^1.5.6",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.3.0",
    "jsdom": "^31.0.0",
    "tailwindcss": "^4.3.5",
    "typescript": "^7.0.2",
    "vite": "^8.3.6",
    "vitest": "^5.1.0"
  }
}
```

Run: `pnpm install && pnpm --filter @bursar/web add -D @testing-library/dom`

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["es2024", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts", "vitest.config.ts"]
}
```

`apps/web/vite.config.ts`:

```ts
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/healthz": "http://127.0.0.1:8080",
    },
  },
});
```

`apps/web/vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
```

`apps/web/src/test/setup.ts`:

```ts
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Bursar</title>
  </head>
  <body class="bg-slate-50 text-slate-900 antialiased">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/web/src/styles.css`:

```css
@import "tailwindcss";
```

- [ ] **Step 2: Write the translations and the failing tests**

`apps/web/src/i18n/en.json`:

```json
{
  "app": { "name": "Bursar" },
  "common": {
    "loading": "Loading…",
    "serverUnavailable": "The server is not reachable. Try again in a moment.",
    "language": "Language"
  },
  "setup": {
    "title": "Set up Bursar",
    "intro": "Create the owner account. The setup code is in the file named setup-code inside the server's data directory.",
    "setupCode": "Setup code",
    "password": "Password",
    "passwordConfirm": "Repeat password",
    "passwordTooShort": "The password must be at least {{min}} characters.",
    "passwordMismatch": "The passwords do not match.",
    "startFailed": "Setup could not start. Check the setup code and try again.",
    "continue": "Continue",
    "scanTitle": "Add Bursar to your authenticator",
    "scanHelp": "Scan the QR code with an authenticator app, then enter the 6-digit code it shows.",
    "qrAlt": "QR code for the authenticator app",
    "manualSecret": "Manual entry key",
    "code": "Authenticator code",
    "confirmFailed": "The code is not valid. Check the time on your phone and try again.",
    "confirm": "Finish setup"
  },
  "login": {
    "title": "Sign in",
    "password": "Password",
    "code": "Authenticator code",
    "submit": "Sign in",
    "failed": "Wrong password or code.",
    "tooMany": "Too many attempts. Wait 15 minutes and try again."
  },
  "home": {
    "welcome": "Bursar is ready",
    "empty": "No bank accounts or documents yet.",
    "logout": "Sign out"
  }
}
```

`apps/web/src/i18n/it.json`:

```json
{
  "app": { "name": "Bursar" },
  "common": {
    "loading": "Caricamento…",
    "serverUnavailable": "Il server non risponde. Riprova tra poco.",
    "language": "Lingua"
  },
  "setup": {
    "title": "Configura Bursar",
    "intro": "Crea l'account del proprietario. Il codice di setup si trova nel file setup-code, nella cartella dati del server.",
    "setupCode": "Codice di setup",
    "password": "Password",
    "passwordConfirm": "Ripeti la password",
    "passwordTooShort": "La password deve avere almeno {{min}} caratteri.",
    "passwordMismatch": "Le password non coincidono.",
    "startFailed": "Impossibile avviare il setup. Controlla il codice e riprova.",
    "continue": "Continua",
    "scanTitle": "Aggiungi Bursar all'app di autenticazione",
    "scanHelp": "Inquadra il QR code con un'app di autenticazione, poi inserisci il codice a 6 cifre che mostra.",
    "qrAlt": "QR code per l'app di autenticazione",
    "manualSecret": "Chiave per l'inserimento manuale",
    "code": "Codice di autenticazione",
    "confirmFailed": "Codice non valido. Controlla l'ora del telefono e riprova.",
    "confirm": "Completa il setup"
  },
  "login": {
    "title": "Accedi",
    "password": "Password",
    "code": "Codice di autenticazione",
    "submit": "Accedi",
    "failed": "Password o codice errati.",
    "tooMany": "Troppi tentativi. Attendi 15 minuti e riprova."
  },
  "home": {
    "welcome": "Bursar è pronto",
    "empty": "Non hai ancora collegato conti o caricato documenti.",
    "logout": "Esci"
  }
}
```

`apps/web/src/i18n/i18n.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import english from "./en.json";
import italian from "./it.json";

function flatten(value: object, prefix = ""): Record<string, unknown> {
  return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, child]) => {
    if (typeof child === "object" && child !== null) Object.assign(acc, flatten(child, `${prefix}${key}.`));
    else acc[`${prefix}${key}`] = child;
    return acc;
  }, {});
}

describe("translations", () => {
  it("define the same keys in Italian and English", () => {
    expect(Object.keys(flatten(italian)).sort()).toEqual(Object.keys(flatten(english)).sort());
  });

  it("contain no empty strings", () => {
    for (const value of [...Object.values(flatten(italian)), ...Object.values(flatten(english))]) {
      expect(typeof value === "string" && value.trim().length > 0).toBe(true);
    }
  });
});
```

`apps/web/src/pages/LoginPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { LoginPage } from "./LoginPage";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LoginPage />
    </QueryClientProvider>,
  );
}

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function submit(password: string, code: string) {
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("LoginPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the credentials and shows an error on 401", async () => {
    const fetchMock = stubFetch(401, { error: "Invalid credentials" });
    renderPage();
    submit("correct horse battery", "123456");
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong password or code.");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ password: "correct horse battery", code: "123456" }),
      }),
    );
  });

  it("shows the lockout message on 429", async () => {
    stubFetch(429, { error: "Too many attempts" });
    renderPage();
    submit("whatever", "123456");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Too many attempts. Wait 15 minutes and try again.",
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @bursar/web test`
Expected: `i18n.test.ts` passes (JSON exists); `LoginPage.test.tsx` FAILS with `Failed to resolve import "../i18n"`.

- [ ] **Step 4: Write the implementation**

`apps/web/src/i18n/index.ts`:

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import it from "./it.json";

export const SUPPORTED_LANGUAGES = ["it", "en"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const STORAGE_KEY = "bursar.language";

function initialLanguage(): Language {
  const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (stored === "it" || stored === "en") return stored;
  return globalThis.navigator?.language?.toLowerCase().startsWith("it") ? "it" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, it: { translation: it } },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLanguage(language: Language): void {
  globalThis.localStorage?.setItem(STORAGE_KEY, language);
  document.documentElement.lang = language;
  void i18n.changeLanguage(language);
}

export default i18n;
```

`apps/web/src/api.ts`:

```ts
import type {
  AuthStatus,
  LoginRequest,
  SetupConfirmRequest,
  SetupStartRequest,
  SetupStartResponse,
} from "@bursar/shared";

export const AUTH_STATUS_KEY = ["auth-status"] as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
        ? data.error
        : response.statusText;
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export const api = {
  status: () => request<AuthStatus>("GET", "/api/auth/status"),
  setupStart: (body: SetupStartRequest) =>
    request<SetupStartResponse>("POST", "/api/auth/setup/start", body),
  setupConfirm: (body: SetupConfirmRequest) =>
    request<{ ok: true }>("POST", "/api/auth/setup/confirm", body),
  login: (body: LoginRequest) => request<{ ok: true }>("POST", "/api/auth/login", body),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
};
```

`apps/web/src/components/ui.tsx`:

```tsx
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Card({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto mt-16 w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      {children}
    </main>
  );
}

export function Field({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mb-4 block text-sm font-medium text-slate-700">
      {label}
      <input
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none"
        {...input}
      />
    </label>
  );
}

export function Button({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
      {...props}
    >
      {children}
    </button>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mb-4 text-sm text-red-700">
      {children}
    </p>
  );
}
```

`apps/web/src/components/LanguageSwitcher.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { type Language, setLanguage } from "../i18n";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <label className="text-sm text-slate-600">
      {t("common.language")}{" "}
      <select
        className="rounded-md border border-slate-300 bg-white px-2 py-1"
        value={i18n.language}
        onChange={(event) => setLanguage(event.target.value as Language)}
      >
        <option value="it">Italiano</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
```

`apps/web/src/pages/LoginPage.tsx`:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, AUTH_STATUS_KEY, api } from "../api";
import { Button, Card, ErrorText, Field } from "../components/ui";

export function LoginPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY }),
  });

  let errorMessage: string | null = null;
  if (login.error instanceof ApiError && login.error.status === 429) errorMessage = t("login.tooMany");
  else if (login.error) errorMessage = t("login.failed");

  return (
    <Card>
      <h1 className="mb-6 text-xl font-semibold">{t("login.title")}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate({ password, code });
        }}
      >
        {errorMessage && <ErrorText>{errorMessage}</ErrorText>}
        <Field
          label={t("login.password")}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Field
          label={t("login.code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.trim())}
        />
        <Button type="submit" disabled={login.isPending}>
          {t("login.submit")}
        </Button>
      </form>
    </Card>
  );
}
```

`apps/web/src/pages/SetupPage.tsx`:

```tsx
import { PASSWORD_MIN_LENGTH, type SetupStartResponse } from "@bursar/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AUTH_STATUS_KEY, api } from "../api";
import { Button, Card, ErrorText, Field } from "../components/ui";

export function SetupPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [enrolment, setEnrolment] = useState<SetupStartResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const start = useMutation({ mutationFn: api.setupStart, onSuccess: setEnrolment });
  const confirm = useMutation({
    mutationFn: api.setupConfirm,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY }),
  });

  useEffect(() => {
    if (!enrolment) return;
    let cancelled = false;
    QRCode.toDataURL(enrolment.otpauthUri, { margin: 1, width: 224 }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [enrolment]);

  if (!enrolment) {
    const error = localError ?? (start.error ? t("setup.startFailed") : null);
    return (
      <Card>
        <h1 className="mb-2 text-xl font-semibold">{t("setup.title")}</h1>
        <p className="mb-6 text-sm text-slate-600">{t("setup.intro")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (password.length < PASSWORD_MIN_LENGTH) {
              setLocalError(t("setup.passwordTooShort", { min: PASSWORD_MIN_LENGTH }));
            } else if (password !== passwordConfirm) {
              setLocalError(t("setup.passwordMismatch"));
            } else {
              setLocalError(null);
              start.mutate({ setupCode, password });
            }
          }}
        >
          {error && <ErrorText>{error}</ErrorText>}
          <Field
            label={t("setup.setupCode")}
            autoComplete="off"
            required
            value={setupCode}
            onChange={(event) => setSetupCode(event.target.value)}
          />
          <Field
            label={t("setup.password")}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Field
            label={t("setup.passwordConfirm")}
            type="password"
            autoComplete="new-password"
            required
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
          />
          <Button type="submit" disabled={start.isPending}>
            {t("setup.continue")}
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-2 text-xl font-semibold">{t("setup.scanTitle")}</h1>
      <p className="mb-4 text-sm text-slate-600">{t("setup.scanHelp")}</p>
      {qrDataUrl && (
        <img src={qrDataUrl} alt={t("setup.qrAlt")} className="mx-auto mb-4 h-56 w-56" />
      )}
      <p className="mb-6 break-all rounded-md bg-slate-100 p-2 font-mono text-xs">
        {t("setup.manualSecret")}: {enrolment.secret}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          confirm.mutate({ setupToken: enrolment.setupToken, code });
        }}
      >
        {confirm.error && <ErrorText>{t("setup.confirmFailed")}</ErrorText>}
        <Field
          label={t("setup.code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.trim())}
        />
        <Button type="submit" disabled={confirm.isPending}>
          {t("setup.confirm")}
        </Button>
      </form>
    </Card>
  );
}
```

`apps/web/src/pages/HomePage.tsx`:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AUTH_STATUS_KEY, api } from "../api";
import { LanguageSwitcher } from "../components/LanguageSwitcher";

export function HomePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY }),
  });

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <span className="text-lg font-semibold">{t("app.name")}</span>
        <div className="flex items-center gap-4">
          <LanguageSwitcher />
          <button
            type="button"
            className="text-sm font-medium text-slate-700 hover:text-slate-900"
            onClick={() => logout.mutate()}
          >
            {t("home.logout")}
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="mb-2 text-2xl font-semibold">{t("home.welcome")}</h1>
        <p className="text-slate-600">{t("home.empty")}</p>
      </main>
    </div>
  );
}
```

`apps/web/src/App.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AUTH_STATUS_KEY, api } from "./api";
import { Card } from "./components/ui";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";

export function App() {
  const { t } = useTranslation();
  const status = useQuery({ queryKey: AUTH_STATUS_KEY, queryFn: api.status });

  if (status.isPending) return <Card>{t("common.loading")}</Card>;
  if (status.isError) return <Card>{t("common.serverUnavailable")}</Card>;
  if (status.data.setupRequired) return <SetupPage />;
  if (!status.data.authenticated) return <LoginPage />;
  return <HomePage />;
}
```

`apps/web/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./i18n";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 5: Run tests, typecheck, lint and build**

Run: `pnpm --filter @bursar/web test && pnpm --filter @bursar/web typecheck && pnpm lint && pnpm --filter @bursar/web build && ls apps/web/dist apps/web/dist/assets`
Expected: `Tests  4 passed (4)`; `tsc` exits 0; Biome clean; `dist/index.html` plus hashed `.js` and `.css` files under `dist/assets/`.

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add bilingual panel shell with setup, login and home"
```

---

### Task 12: Docker image and compose stack

**Files:**
- Create: `deploy/Dockerfile`, `deploy/compose.yaml`, `deploy/compose.dev.yaml`, `deploy/compose.claude.yaml`, `deploy/env.example`, `.dockerignore`

**Interfaces:**
- Consumes: `pnpm build` output (Tasks 10–11); environment variables from Task 2.
- Produces: image `bursar:local` running as `node` (uid 1000) with read-only root filesystem; compose project `bursar` with service `app` (no published ports), profile `tunnel` adding `cloudflared`; `compose.claude.yaml` mounting `${BURSAR_SECRETS_DIR}/claude_credential` as `${BURSAR_CLAUDE_CREDENTIAL_ENV}_FILE`.

- [ ] **Step 1: Write the image and compose files**

`.dockerignore`:

```
**/node_modules
**/dist
**/data
**/secrets
**/.env
**/.env.*
.git
coverage
playwright-report
test-results
docs
```

`deploy/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /src

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @bursar/web build && pnpm --filter @bursar/server build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@bursar/server..."

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    BURSAR_HOST=0.0.0.0 \
    BURSAR_PORT=8080 \
    BURSAR_DATA_DIR=/data \
    BURSAR_MIGRATIONS_DIR=/app/apps/server/drizzle \
    BURSAR_WEB_DIST=/app/apps/web/dist
WORKDIR /app/apps/server
COPY --from=prod-deps /src/node_modules /app/node_modules
COPY --from=prod-deps /src/apps/server/node_modules /app/apps/server/node_modules
COPY --from=build /src/apps/server/package.json /app/apps/server/package.json
COPY --from=build /src/apps/server/dist /app/apps/server/dist
COPY --from=build /src/apps/server/drizzle /app/apps/server/drizzle
COPY --from=build /src/apps/web/dist /app/apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

`deploy/compose.yaml`:

```yaml
name: bursar

services:
  app:
    image: ${BURSAR_IMAGE:-bursar:local}
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    restart: unless-stopped
    init: true
    environment:
      BURSAR_PUBLIC_URL: ${BURSAR_PUBLIC_URL:?set BURSAR_PUBLIC_URL}
      TZ: ${TZ:?set TZ}
      BURSAR_MASTER_KEY_FILE: /run/secrets/master_key
      BURSAR_LOG_LEVEL: ${BURSAR_LOG_LEVEL:-info}
      CF_ACCESS_TEAM_DOMAIN: ${CF_ACCESS_TEAM_DOMAIN:-}
      CF_ACCESS_AUD: ${CF_ACCESS_AUD:-}
    secrets:
      - master_key
    volumes:
      - bursar-data:/data
    read_only: true
    tmpfs:
      - /tmp
      - /home/node:uid=1000,gid=1000,mode=700
    mem_limit: ${BURSAR_MEM_LIMIT:-3g}
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  cloudflared:
    image: cloudflare/cloudflared:2026.10.7
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN:-}
    depends_on:
      app:
        condition: service_healthy
    mem_limit: 128m
    profiles: [tunnel]

secrets:
  master_key:
    file: ${BURSAR_SECRETS_DIR:-./secrets}/master_key

volumes:
  bursar-data:
```

`deploy/compose.dev.yaml`:

```yaml
services:
  app:
    ports:
      - "127.0.0.1:8080:8080"
```

`deploy/compose.claude.yaml`:

```yaml
services:
  app:
    environment:
      - ${BURSAR_CLAUDE_CREDENTIAL_ENV:-ANTHROPIC_API_KEY}_FILE=/run/secrets/claude_credential
    secrets:
      - claude_credential

secrets:
  claude_credential:
    file: ${BURSAR_SECRETS_DIR:-./secrets}/claude_credential
```

`deploy/env.example`:

```
# Copy to deploy/.env for local use, or to <deploy dir>/.env on a host. Never commit the copy.
BURSAR_PUBLIC_URL=https://bursar.example.com
TZ=Europe/Rome
BURSAR_SECRETS_DIR=./secrets
BURSAR_MEM_LIMIT=3g

# Cloudflare Access (optional, recommended): set both or neither.
CF_ACCESS_TEAM_DOMAIN=
CF_ACCESS_AUD=

# Cloudflare Tunnel token, used by the "tunnel" profile.
TUNNEL_TOKEN=

# Which variable compose.claude.yaml fills: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
BURSAR_CLAUDE_CREDENTIAL_ENV=ANTHROPIC_API_KEY
```

- [ ] **Step 2: Validate the compose model**

Run: `BURSAR_PUBLIC_URL=http://127.0.0.1:8080 TZ=UTC docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml config --quiet && echo compose-ok`
Expected: `compose-ok`.

- [ ] **Step 3: Build and run the container locally (Owner gate: starts a container)**

```bash
mkdir -p deploy/secrets
node apps/server/dist/cli.js init --out "$PWD/deploy/secrets/master_key"
printf 'BURSAR_PUBLIC_URL=http://127.0.0.1:8080\nTZ=Europe/Rome\n' > deploy/.env
docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml up -d --build --wait app
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/api/auth/status
docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml exec app sh -c 'test -s /data/setup-code && echo setup-code-present'
docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml exec app sh -c 'touch /app/probe 2>/dev/null || echo root-fs-read-only'
docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml exec app id -u
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' bursar-app-1
```

Expected, in order: `{"ok":true}`, `{"setupRequired":true,"authenticated":false}`, `setup-code-present`, `root-fs-read-only`, `1000`, and a memory line (record the value in the commit body). If the container exits with `EACCES` on `/run/secrets/master_key` under Docker Desktop, run `chmod 644 deploy/secrets/master_key` (local development only) and retry. On Linux hosts the file is owned by uid 1000 with mode 600 (Task 16).

Then open `http://127.0.0.1:8080` in a browser: the setup page renders and the browser console shows no CSP violations.

- [ ] **Step 4: Stop the local stack**

Run: `docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml down`
Expected: container and network removed; the `bursar_bursar-data` volume stays (remove it with `docker volume rm bursar_bursar-data` only when you want a clean first run).

- [ ] **Step 5: Commit**

```bash
git status
git add .dockerignore deploy/Dockerfile deploy/compose.yaml deploy/compose.dev.yaml deploy/compose.claude.yaml deploy/env.example
git diff --cached --stat
git commit -m "build(deploy): add multi-stage image and compose stack with tunnel profile"
```

Expected: `git status` shows `deploy/.env` and `deploy/secrets/` as ignored (absent from the untracked list).

---

### Task 13: Agent SDK in the container (gate V2)

**Files:**
- Create: `apps/server/src/gates/sdk-gate.ts`, `docs/decisions/0002-agent-sdk-container.md`
- Modify: `apps/server/package.json` (add `@anthropic-ai/claude-agent-sdk`), `apps/server/tsup.config.ts` (add the `sdk-gate` entry)

**Interfaces:**
- Consumes: `loadClaudeCredential` from `config.ts`.
- Produces: `dist/sdk-gate.js`, which runs one isolated `query()` (`tools: []`, `settingSources: []`, `strictMcpConfig: true`, `persistSession: false`, `CLAUDE_CONFIG_DIR` and `HOME` in fresh temp directories) and prints JSON `{ ok, answeredOk, costUsd, filesWritten, transcripts }`. Exit 0 only when the model answered `OK` and no `.jsonl` transcript was written. M2 reuses these isolation options.

- [ ] **Step 1: Add the SDK dependency**

Run: `pnpm --filter @bursar/server add @anthropic-ai/claude-agent-sdk@^0.3.319`
Expected: install succeeds; the lockfile lists the platform packages as optional dependencies. If pnpm reports missing peers (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`), add them with `pnpm --filter @bursar/server add` without a version.

- [ ] **Step 2: Write the gate script**

`apps/server/src/gates/sdk-gate.ts`:

```ts
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadClaudeCredential } from "../config";

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function main(): Promise<number> {
  const credential = loadClaudeCredential(process.env);
  if (!credential) {
    console.error("No Claude credential configured (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)");
    return 2;
  }
  const configDir = mkdtempSync(path.join(tmpdir(), "claude-config-"));
  const workDir = mkdtempSync(path.join(tmpdir(), "claude-work-"));

  let ok = false;
  let answer = "";
  let costUsd: number | undefined;
  for await (const message of query({
    prompt: "Reply with exactly the word OK and nothing else.",
    options: {
      tools: [],
      allowedTools: [],
      mcpServers: {},
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      model: "haiku",
      maxTurns: 1,
      cwd: workDir,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: workDir,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
        [credential.envName]: credential.value,
      },
    },
  })) {
    if (message.type === "result") {
      ok = message.subtype === "success";
      if (message.subtype === "success") answer = message.result;
      costUsd = message.total_cost_usd;
    }
  }

  const written = [...listFiles(configDir), ...listFiles(workDir)];
  const transcripts = written.filter((file) => file.endsWith(".jsonl"));
  const answeredOk = answer.trim() === "OK";
  console.log(
    JSON.stringify(
      {
        ok,
        answeredOk,
        costUsd,
        filesWritten: written.map((file) => path.relative(tmpdir(), file)),
        transcripts: transcripts.map((file) => path.relative(tmpdir(), file)),
      },
      null,
      2,
    ),
  );
  return ok && answeredOk && transcripts.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
```

In `apps/server/tsup.config.ts`, change the entry line to:

```ts
  entry: { index: "src/index.ts", cli: "src/cli.ts", "sdk-gate": "src/gates/sdk-gate.ts" },
```

- [ ] **Step 3: Typecheck and build**

Run: `pnpm --filter @bursar/server typecheck && pnpm --filter @bursar/server build && ls apps/server/dist/sdk-gate.js`
Expected: `tsc` exits 0; the file exists. If `persistSession` or `total_cost_usd` do not exist in the installed SDK types, stop and report: gate V2 depends on them (spec §15).

- [ ] **Step 4: Provide the credential (Owner gate)**

The owner runs `claude setup-token` in their own terminal (not through the agent session), copies the printed token, and writes it to `deploy/secrets/claude_credential` without echoing it, for example with `pbpaste > deploy/secrets/claude_credential && chmod 600 deploy/secrets/claude_credential` after copying. Then the owner appends `BURSAR_CLAUDE_CREDENTIAL_ENV=CLAUDE_CODE_OAUTH_TOKEN` to `deploy/.env`.

- [ ] **Step 5: Run the gate in the container (Owner gate: starts a container and uses the subscription)**

Run:

```bash
docker compose -f deploy/compose.yaml -f deploy/compose.dev.yaml -f deploy/compose.claude.yaml \
  run --rm --no-deps --build app node dist/sdk-gate.js
echo "exit=$?"
```

Expected: JSON with `"ok": true`, `"answeredOk": true`, `"transcripts": []`, and `exit=0`. Under Docker Desktop, `chmod 644 deploy/secrets/claude_credential` if the read fails with `EACCES` (local development only).

- [ ] **Step 6: Record the gate result**

`docs/decisions/0002-agent-sdk-container.md`:

````markdown
# 0002 — Agent SDK isolation in the container (gate V2)

- **Date:** <today's date>
- **Status:** accepted for local Docker; host confirmation in Task 16

## Question

Does the Agent SDK run inside the read-only container with a credential from a `*_FILE` secret, and do `persistSession: false` plus a temporary `CLAUDE_CONFIG_DIR` keep transcripts off the disk? (Spec §15, V2.)

## Evidence

Command: `docker compose … run --rm --no-deps app node dist/sdk-gate.js`

```json
<paste the JSON printed in Task 13 Step 5>
```

## Decision

Agent runs use: `tools: []`, `settingSources: []`, `strictMcpConfig: true`, `persistSession: false`, `CLAUDE_CONFIG_DIR` and `HOME` in per-run temporary directories under the tmpfs, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`. Files listed under `filesWritten` live only on tmpfs.
````

- [ ] **Step 7: Commit**

```bash
git add apps/server/package.json apps/server/tsup.config.ts apps/server/src/gates/sdk-gate.ts docs/decisions/0002-agent-sdk-container.md pnpm-lock.yaml
git commit -m "feat(server): add Agent SDK isolation probe (gate V2)"
```

---

### Task 14: SDK redistribution terms (gate V3)

**Files:**
- Create: `docs/decisions/0003-sdk-redistribution.md`

**Interfaces:**
- Produces: a recorded decision on whether release images may bundle the SDK. Until a later decision says otherwise, deployments build from source (Task 16 already does).

- [ ] **Step 1: Collect the terms**

Read the installed package's `README.md` and any `LICENSE*` file under `apps/server/node_modules/@anthropic-ai/claude-agent-sdk/` and the platform package `@anthropic-ai/claude-agent-sdk-linux-x64`, and the redistribution-related sections of the Anthropic Commercial Terms linked from the SDK overview. Quote the exact sentences about licence and redistribution.

- [ ] **Step 2: Write the decision**

`docs/decisions/0003-sdk-redistribution.md`:

````markdown
# 0003 — Publishing images that bundle the Agent SDK (gate V3)

- **Date:** <today's date>
- **Status:** accepted

## Question

May a public container image include `@anthropic-ai/claude-agent-sdk` and its bundled Claude Code binary? (Spec §15, V3.)

## Evidence

Package `license` field: `SEE LICENSE IN README.md`.

> <quote the README licence sentence>

> <quote the relevant Commercial Terms sentence(s), with the section name>

## Decision

Rule applied: publish images only if the terms explicitly allow redistribution of the SDK in a container image.

Outcome: <either "Explicitly allowed: the release workflow may push images to GHCR." or "Not explicitly allowed: no public images; operators build from source with `docker compose build`, and the release workflow only builds and tests.">
````

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/0003-sdk-redistribution.md
git commit -m "docs(decisions): record SDK redistribution decision (gate V3)"
```

---

### Task 15: CI workflow, licence and README

**Files:**
- Create: `.github/workflows/ci.yml`, `LICENSE`, `README.md`

**Interfaces:**
- Consumes: root scripts `lint`, `typecheck`, `test`, `build` (Task 1).
- Produces: workflow `CI` with one job `check` on `ubuntu-latest`.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
    paths-ignore: ["**/*.md", "docs/**"]
  pull_request:
    paths-ignore: ["**/*.md", "docs/**"]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
      - name: Scan for secrets
        run: |
          curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
            | tar -xz gitleaks
          ./gitleaks git --redact --no-banner .
```

- [ ] **Step 2: Write the licence and README**

`LICENSE`: the standard MIT licence text with the line `Copyright (c) 2026 Alessandro Vettor`.

`README.md`:

```markdown
# Bursar

Bursar is a self-hosted personal finance assistant. It reads your bank accounts through the Enable Banking API (read-only), keeps an encrypted archive of your financial documents, and runs a team of Claude agents that write a daily report on how your money is managed.

> **Status:** early development. Nothing here is ready for real use yet.

## Where your data goes

Bursar stores everything on your own server, encrypted at rest. Processing still involves third parties: Anthropic receives what the agents read, Enable Banking brokers bank data, and Cloudflare terminates TLS if you use a Cloudflare Tunnel.

## Development

Requirements: Node 24, pnpm (via `packageManager`), Docker, gitleaks.

    pnpm install
    pnpm test

## License

MIT
```

- [ ] **Step 3: Lint the workflow and run the full local pipeline**

Run:

```bash
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color && echo actionlint-ok
pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build
gitleaks git --redact --no-banner .
```

Expected: `actionlint-ok`; every package's Vitest summary with 0 failed (paste all three summary lines: shared, server, web); gitleaks prints `no leaks found`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml LICENSE README.md
git commit -m "ci: add check workflow on GitHub-hosted runners, licence and README"
```

---

### Task 16: First deployment on the reference host

**Files:**
- Create: `deploy/deploy.sh`, `deploy/remote-update.sh`, `docs/deployment.md`
- Modify: `docs/decisions/0002-agent-sdk-container.md` (host confirmation)

**Interfaces:**
- Consumes: the compose stack (Task 12), `dist/sdk-gate.js` (Task 13).
- Produces: `deploy/deploy.sh [git-ref]` reading `BURSAR_DEPLOY_HOST` and `BURSAR_DEPLOY_DIR` from the environment or from `.env.deploy` (gitignored); on the host, `<deploy dir>/releases/<UTC timestamp>-<short sha>/`, a `current` symlink, `<deploy dir>/.env` and `<deploy dir>/secrets/`.

Operator values (host alias, deploy directory, hostname, Cloudflare team domain and audience) come from the owner's private notes and are never written into the repository.

- [ ] **Step 1: Write the deploy scripts**

`deploy/deploy.sh`:

```bash
#!/usr/bin/env bash
# Builds and starts Bursar on a remote Docker host from a git revision.
# Usage: deploy/deploy.sh [git-ref]
# Reads BURSAR_DEPLOY_HOST (ssh alias) and BURSAR_DEPLOY_DIR (absolute path) from the
# environment or from .env.deploy at the repository root.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if [[ -f .env.deploy ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env.deploy
  set +a
fi
: "${BURSAR_DEPLOY_HOST:?set BURSAR_DEPLOY_HOST}"
: "${BURSAR_DEPLOY_DIR:?set BURSAR_DEPLOY_DIR}"

ref="${1:-HEAD}"
release="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short "$ref")"
workdir="$(mktemp -d)"
archive="$workdir/release.tar.gz"
cleanup() { rm -f "$archive"; rmdir "$workdir"; }
trap cleanup EXIT

git archive --format=tar.gz -o "$archive" "$ref"
scp -q "$archive" "$BURSAR_DEPLOY_HOST:$BURSAR_DEPLOY_DIR/incoming-$release.tar.gz"
ssh "$BURSAR_DEPLOY_HOST" \
  "set -e; d='$BURSAR_DEPLOY_DIR'; r='$release'; \
   mkdir -p \"\$d/releases/\$r\"; \
   tar -xzf \"\$d/incoming-\$r.tar.gz\" -C \"\$d/releases/\$r\"; \
   rm \"\$d/incoming-\$r.tar.gz\"; \
   bash \"\$d/releases/\$r/deploy/remote-update.sh\" \"\$d\" \"\$r\""
```

`deploy/remote-update.sh`:

```bash
#!/usr/bin/env bash
# Runs on the Docker host: points "current" at a release and (re)starts the stack.
# Usage: remote-update.sh <deploy dir> <release name>
set -euo pipefail

dir="$1"
release="$2"
release_dir="$dir/releases/$release"

[[ -f "$dir/.env" ]] || { echo "Missing $dir/.env" >&2; exit 1; }
[[ -f "$dir/secrets/master_key" ]] || { echo "Missing $dir/secrets/master_key" >&2; exit 1; }

compose=(docker compose --env-file "$dir/.env" -f "$release_dir/deploy/compose.yaml")
if [[ -f "$dir/secrets/claude_credential" ]]; then
  compose+=(-f "$release_dir/deploy/compose.claude.yaml")
fi

"${compose[@]}" --profile tunnel up -d --build --remove-orphans --wait --wait-timeout 180
ln -sfn "$release_dir" "$dir/current"
"${compose[@]}" --profile tunnel ps
```

Run: `chmod +x deploy/deploy.sh deploy/remote-update.sh && bash -n deploy/deploy.sh && bash -n deploy/remote-update.sh && echo syntax-ok`
Expected: `syntax-ok`.

- [ ] **Step 2: Write the generic deployment guide**

`docs/deployment.md`:

````markdown
# Deployment (reference: Docker host + Cloudflare Tunnel + Access)

This guide uses placeholders: `<host>` (ssh alias), `<dir>` (absolute deploy directory, e.g. `/opt/bursar`), `<hostname>` (public hostname of the panel).

## 1. Cloudflare

1. The hostname's zone must be on Cloudflare.
2. Zero Trust → Networks → Tunnels → create a Cloudflared tunnel named `bursar`. Copy its token.
3. In the tunnel, add a public hostname `<hostname>` with service `http://app:8080`.
4. Zero Trust → Access → Applications → add a self-hosted application for `<hostname>` with an Allow policy for your email. Copy the **Application Audience (AUD) tag** and note your team domain (`<team>.cloudflareaccess.com`).

## 2. Host preparation

    ssh <host> 'install -d -m 755 <dir> <dir>/releases && install -d -m 700 -o 1000 -g 1000 <dir>/secrets'
    ssh <host> 'umask 077; head -c 32 /dev/urandom | base64 > <dir>/secrets/master_key; chown 1000:1000 <dir>/secrets/master_key; chmod 600 <dir>/secrets/master_key'

Keep an offline copy of `<dir>/secrets/master_key` (for example in a password manager): without it the data cannot be decrypted.

Create `<dir>/.env` (mode 600) from `deploy/env.example` with `BURSAR_PUBLIC_URL=https://<hostname>`, your `TZ`, `BURSAR_SECRETS_DIR=<dir>/secrets`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `TUNNEL_TOKEN`.

Optional Claude credential for the agent runtime: write it to `<dir>/secrets/claude_credential` (owner 1000, mode 600) and set `BURSAR_CLAUDE_CREDENTIAL_ENV` in `.env`.

## 3. Deploy

    BURSAR_DEPLOY_HOST=<host> BURSAR_DEPLOY_DIR=<dir> deploy/deploy.sh

The script uploads the current commit, builds the image on the host and waits until the app is healthy. Old releases stay under `<dir>/releases/`; remove them manually when no longer needed.

## 4. First run

1. Open `https://<hostname>`, pass the Access login.
2. Read the setup code on the host: `ssh <host> 'docker exec bursar-app-1 cat /data/setup-code'`.
3. Enter it with a new password, then enrol the authenticator app.
````

- [ ] **Step 3: Configure Cloudflare (Owner gate)**

The owner performs section 1 of `docs/deployment.md`, keeps the tunnel token private, and tells the agent the AUD tag and team domain (both non-secret).

- [ ] **Step 4: Prepare the host (Owner gate)**

With the owner's go-ahead, run the two commands of section 2 against the reference host. Write `<dir>/.env` with every non-secret value through `ssh <host> "umask 077; printf '%s\n' 'BURSAR_PUBLIC_URL=https://<hostname>' 'TZ=Europe/Rome' 'BURSAR_SECRETS_DIR=<dir>/secrets' 'BURSAR_MEM_LIMIT=3g' 'CF_ACCESS_TEAM_DOMAIN=<team domain>' 'CF_ACCESS_AUD=<aud>' 'BURSAR_CLAUDE_CREDENTIAL_ENV=CLAUDE_CODE_OAUTH_TOKEN' > <dir>/.env"`. The owner then adds `TUNNEL_TOKEN=…` with an editor on the host, copies the master key offline, and writes the Claude credential file. Verify ownership and modes:

Run: `ssh <host> 'ls -la <dir> <dir>/secrets'`
Expected: `.env` mode `-rw-------` owned by root; `secrets/` `drwx------` owned by `1000`; `master_key` and `claude_credential` `-rw-------` owned by `1000`. File contents are never printed.

- [ ] **Step 5: Deploy (Owner gate)**

Create `.env.deploy` at the repository root (gitignored) with `BURSAR_DEPLOY_HOST` and `BURSAR_DEPLOY_DIR`, then:

Run: `deploy/deploy.sh`
Expected: compose prints the build, then `bursar-app-1` as `healthy` and `bursar-cloudflared-1` as `running`.

- [ ] **Step 6: Verify end to end**

Run:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<hostname>/healthz
ssh <host> 'docker exec bursar-app-1 node -e "fetch(\"http://127.0.0.1:8080/api/auth/status\").then(r=>console.log(r.status))"'
ssh <host> 'docker exec bursar-app-1 node -e "fetch(\"http://127.0.0.1:8080/healthz\").then(r=>console.log(r.status))"'
ssh <host> 'docker stats --no-stream --format "{{.Name}} {{.MemUsage}}" bursar-app-1'
```

Expected: `302` or `403` from Cloudflare (Access blocks unauthenticated requests at the edge); `403` from the app's Access guard inside the network; `200` for the internal health check; a memory line to record.

Then the owner completes section 4 of `docs/deployment.md` in the browser: Access login, setup code, password, authenticator. After a reload the home page shows "Bursar è pronto" or "Bursar is ready"; sign out and sign in again work.

- [ ] **Step 7: Confirm gate V2 on the host (Owner gate: uses the subscription)**

Run: `ssh <host> 'cd <dir>/current/deploy && docker compose --env-file <dir>/.env -f compose.yaml -f compose.claude.yaml run --rm --no-deps app node dist/sdk-gate.js; echo exit=$?'`
Expected: the same JSON shape as Task 13 with `"transcripts": []` and `exit=0`. Append it under a `## Host confirmation` heading in `docs/decisions/0002-agent-sdk-container.md` and change the status line to `accepted`.

- [ ] **Step 8: Commit**

```bash
git status
git add deploy/deploy.sh deploy/remote-update.sh docs/deployment.md docs/decisions/0002-agent-sdk-container.md
git diff --cached
git commit -m "build(deploy): add source-based remote deploy and deployment guide"
```

Before committing, confirm in the diff that no hostname, alias, IP, team domain or AUD value appears.

---

### Task 17: Publish the repository and turn CI on (Owner gate)

**Files:** none (repository settings and remote).

- [ ] **Step 1: Pre-publication scan**

Run:

```bash
gitleaks git --redact --no-banner .
git log --format='%an <%ae>' | sort -u
```

Then search the whole history for the owner's private identifiers (hostname, server alias, IP, personal email), using the values from the owner's private notes: `git log -p --all | grep -n -i -E '<pattern list>' || echo clean`.
Expected: `no leaks found`; a single author line using the GitHub noreply address; `clean`.

- [ ] **Step 2: Merge into main (Owner gate)**

With the owner's explicit go-ahead:

```bash
git switch main
git merge --ff-only feat/m0-foundation
```

If `--ff-only` fails because `main` and the branch diverged, stop and ask the owner how to integrate.

- [ ] **Step 3: Create the public repository and push (Owner gate)**

```bash
gh repo view AlessVett/bursar >/dev/null 2>&1 && echo "name taken" || echo "name free"
gh repo create AlessVett/bursar --public --source . --remote origin \
  --description "Self-hosted personal finance assistant with Enable Banking and Claude agents"
git push -u origin main
```

Expected: `name free`, then the repository URL and a successful push. The global `pre-push-checks` hook runs lint and typecheck first.

- [ ] **Step 4: Watch CI**

Run: `gh run watch --exit-status "$(gh run list --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')"`
Expected: job `check` completes successfully. Paste the final status lines.

- [ ] **Step 5: Account settings (Owner)**

The owner sets a GitHub Actions budget of $0 with "stop usage" under Billing → Budgets, and enables private vulnerability reporting and Dependabot security updates in the repository settings.

---

## M0 exit checklist (spec §14)

- [x] Login works on the public hostname behind Access (Task 16 Step 6).
- [ ] CI green on GitHub-hosted runners (Task 17 Step 4).
- [x] Gates recorded: V1 (`0001`), V2 local and host (`0002`), V3 (`0003`).
- [x] Memory usage of the idle app recorded (Tasks 12 and 16).

## Verification (2026-11-09)

Local pipeline on the M0 branch (Node 24.21.0, pnpm 12.18.0):

| Check | Result |
|-------|--------|
| `pnpm lint` | Checked 87 files, no fixes applied, exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | shared 3/3 (1 file), web 4/4 (2 files), server 200/200 (21 files), exit 0 |
| `pnpm build` | exit 0 |
| `gitleaks git` | 86 commits scanned, no leaks found |

Gates:

- **V1** (SQLCipher with Drizzle and FTS5): passed, `docs/decisions/0001-sqlcipher.md`.
- **V2** (Agent SDK isolation): `ok: true`, `answeredOk: true`, `transcripts: []`, exit 0, both on local Docker and on the production host, `docs/decisions/0002-agent-sdk-container.md`.
- **V3** (SDK redistribution): no published image, images built from source on the host, `docs/decisions/0003-sdk-redistribution.md`.

Container checks (Task 12, local Docker): image built, container healthy, `/healthz` `{"ok":true}`, auth status `{"setupRequired":true,"authenticated":false}`, setup code present, read-only root filesystem, uid 1000, `GET /` served `index.html` with the `content-security-policy` header, memory 175.4 MiB of 3 GiB at idle.

Production host (Task 16, Docker Compose with the `tunnel` profile, Cloudflare Access enabled):

- cloudflared registered 4 tunnel connections; app healthy.
- From outside: `GET https://<hostname>/healthz` returns `302` to the Access login.
- From inside the Docker network, without an Access JWT: `/healthz` `200`, `/api/auth/status` `403`, `/` `403`.
- No "Access is not configured" warning in the startup logs after the Access values were set.
- The owner completed the first run behind Access (setup code, password, TOTP); the setup code file is gone.
- Memory: app 174 MiB of 3 GiB after the first deploy and 49 MiB of 3 GiB idle after the restart; cloudflared 37–38 MiB of 128 MiB.

Open: CI green on GitHub-hosted runners (Task 17), after the repository is published.
