import { readFileSync } from "node:fs";
import { isIP } from "node:net";
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

const HOSTNAME_PATTERN =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** Returns why a public URL is unusable, or undefined when it is acceptable. */
function publicUrlProblem(url: URL): string | undefined {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "must use https (or http on a loopback host)";
  }
  if (url.origin === "null" || !url.hostname) return "must have a host";
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return "must use https (http is allowed only on a loopback host)";
  }
  if (url.username || url.password) return "must not contain credentials";
  if (url.pathname !== "/" || url.search || url.hash) {
    return "must not contain a path, query or fragment";
  }
  return undefined;
}

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

  // An empty value counts as unset, so a blank line in .env cannot change a default.
  const setting = (name: string): string | undefined => env[name]?.trim() || undefined;

  const host = setting("BURSAR_HOST") ?? "127.0.0.1";
  if (isIP(host.replace(/^\[|\]$/g, "")) === 0 && !HOSTNAME_PATTERN.test(host)) {
    problems.push("BURSAR_HOST must be an IP address or a hostname");
  }

  let publicUrl: URL | undefined;
  const rawPublicUrl = setting("BURSAR_PUBLIC_URL");
  if (!rawPublicUrl) {
    problems.push("BURSAR_PUBLIC_URL is required");
  } else {
    try {
      const candidate = new URL(rawPublicUrl);
      const urlProblem = publicUrlProblem(candidate);
      if (urlProblem) problems.push(`BURSAR_PUBLIC_URL ${urlProblem}`);
      else publicUrl = candidate;
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
    host,
    port,
    publicUrl,
    dataDir: path.resolve(setting("BURSAR_DATA_DIR") ?? "./data"),
    timezone,
    logLevel: logLevel as Config["logLevel"],
    masterKey,
    migrationsDir: path.resolve(setting("BURSAR_MIGRATIONS_DIR") ?? "./drizzle"),
    webDistDir: setting("BURSAR_WEB_DIST")
      ? path.resolve(setting("BURSAR_WEB_DIST") as string)
      : null,
    cfAccess: teamDomain && audience ? { teamDomain, audience } : null,
    claude,
  };
}
