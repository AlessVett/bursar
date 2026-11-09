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

export function loadConfig(env: Env = process.env, readFile: ReadFile = defaultReadFile): Config {
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
