import { createPrivateKey } from "node:crypto";
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

export interface EnableBankingConfig {
  /** The application id (a UUID); it is also the `kid` of the signed JWTs. */
  applicationId: string;
  /** The RSA private key the application's certificate was made from, PEM encoded. */
  privateKeyPem: string;
  /** Origin of the API, without a trailing slash. */
  apiBaseUrl: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** `tls` is implicit TLS, `starttls` upgrades and refuses to send in clear, `none` is plain. */
  security: "tls" | "starttls" | "none";
  user: string | null;
  password: string | null;
  /** The `From` header: an address or `Name <address>`. */
  from: string;
}

export interface BackupS3Config {
  endpoint: URL;
  region: string;
  bucket: string;
  /** Key prefix inside the bucket, without a leading or trailing slash. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface BackupConfig {
  dir: string;
  s3: BackupS3Config | null;
}

const HOSTNAME_PATTERN =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** True for localhost, 127.0.0.0/8 and [::1], as `URL.hostname` spells them. */
export function isLoopbackHost(hostname: string): boolean {
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
  /** Use the CF-Connecting-IP header as the client address (only behind Cloudflare). */
  trustCfConnectingIp: boolean;
  claude: ClaudeCredential | null;
  enableBanking: EnableBankingConfig | null;
  smtp: SmtpConfig | null;
  backup: BackupConfig;
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
    let value: string;
    try {
      value = readFile(filePath).trim();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code !== "string") throw error;
      const hint =
        code === "EACCES" || code === "EPERM"
          ? "; make it readable by the user that runs Bursar (uid 1000 in the container)"
          : "";
      throw new ConfigError([
        `${name}_FILE points to ${filePath}, which cannot be read (${code})${hint}`,
      ]);
    }
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_EB_API_BASE_URL = "https://api.enablebanking.com";
const SMTP_SECURITY_MODES = ["tls", "starttls", "none"] as const;
const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const S3_REGION_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
const S3_PREFIX_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** An empty value counts as unset, like `setting` inside `loadConfig`. */
function envSetting(env: Env, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** Runs `fn`; a `ConfigError` it throws is added to `problems` instead of propagating. */
function collect<T>(problems: string[], fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
    return undefined;
  }
}

/** Returns the bare host (IPv6 brackets removed) or undefined when it is not a host. */
function parseHostName(raw: string): string | undefined {
  const bracketed = /^\[(.*)\]$/.exec(raw);
  const host = bracketed ? (bracketed[1] as string) : raw;
  if (bracketed ? isIP(host) !== 6 : isIP(host) === 0 && !HOSTNAME_PATTERN.test(host)) {
    return undefined;
  }
  return host;
}

/**
 * Parses an https origin. The value is never echoed in a problem: a mistyped endpoint can
 * carry credentials in its userinfo.
 */
function parseHttpsOrigin(name: string, raw: string, problems: string[]): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${name} must be an absolute https URL`);
    return undefined;
  }
  const problem =
    url.protocol !== "https:"
      ? "must use https"
      : !url.hostname
        ? "must have a host"
        : url.username || url.password
          ? "must not contain credentials"
          : url.pathname !== "/" || url.search || url.hash
            ? "must not contain a path, query or fragment"
            : undefined;
  if (problem) {
    problems.push(`${name} ${problem}`);
    return undefined;
  }
  return url;
}

/** Env files and orchestrators often carry a PEM on one line with literal `\n` sequences. */
function normalizePem(value: string): string {
  return value.includes("\\n") && !value.includes("\n") ? value.replaceAll("\\n", "\n") : value;
}

/** Why the value is not usable as the application key. Never includes the value. */
function rsaKeyProblem(pem: string): string | undefined {
  try {
    if (createPrivateKey(pem).asymmetricKeyType === "rsa") return undefined;
    return "EB_PRIVATE_KEY must be an RSA private key";
  } catch {
    return "EB_PRIVATE_KEY is not a valid unencrypted PEM private key (PKCS#1 or PKCS#8)";
  }
}

/**
 * Enable Banking: `EB_APPLICATION_ID` and the RSA key (`EB_PRIVATE_KEY` or `EB_PRIVATE_KEY_FILE`)
 * are set together or not at all. `EB_API_BASE_URL` is optional.
 */
export function loadEnableBanking(
  env: Env,
  readFile: ReadFile = defaultReadFile,
): EnableBankingConfig | null {
  const problems: string[] = [];
  const rawId = envSetting(env, "EB_APPLICATION_ID");
  const rawPem = collect(problems, () => readSecret(env, "EB_PRIVATE_KEY", readFile));
  const keyUnreadable = problems.length > 0;
  const keyGiven = rawPem !== undefined || keyUnreadable;

  let apiBaseUrl = DEFAULT_EB_API_BASE_URL;
  const rawBaseUrl = envSetting(env, "EB_API_BASE_URL");
  if (rawBaseUrl) {
    const parsed = parseHttpsOrigin("EB_API_BASE_URL", rawBaseUrl, problems);
    if (parsed) apiBaseUrl = parsed.origin;
  }

  if (rawId === undefined && !keyGiven) {
    if (problems.length > 0) throw new ConfigError(problems);
    return null;
  }
  if (rawId === undefined) {
    problems.push(
      "EB_APPLICATION_ID is required when EB_PRIVATE_KEY (or EB_PRIVATE_KEY_FILE) is set",
    );
  } else if (!UUID_PATTERN.test(rawId)) {
    problems.push("EB_APPLICATION_ID must be a UUID");
  }
  const privateKeyPem = rawPem === undefined ? undefined : normalizePem(rawPem);
  if (!keyGiven) {
    problems.push(
      "EB_PRIVATE_KEY (or EB_PRIVATE_KEY_FILE) is required when EB_APPLICATION_ID is set",
    );
  } else if (privateKeyPem !== undefined) {
    const keyProblem = rsaKeyProblem(privateKeyPem);
    if (keyProblem) problems.push(keyProblem);
  }
  if (problems.length > 0 || rawId === undefined || privateKeyPem === undefined) {
    throw new ConfigError(problems);
  }
  return { applicationId: rawId, privateKeyPem, apiBaseUrl };
}

/**
 * SMTP notifications: unset `SMTP_HOST` means no email. `SMTP_FROM` is required with a host,
 * `SMTP_USER` and the password (`SMTP_PASSWORD` or `SMTP_PASSWORD_FILE`) go together.
 */
export function loadSmtp(env: Env, readFile: ReadFile = defaultReadFile): SmtpConfig | null {
  const problems: string[] = [];
  const rawHost = envSetting(env, "SMTP_HOST");
  const rawFrom = envSetting(env, "SMTP_FROM");
  const user = envSetting(env, "SMTP_USER");
  const password = collect(problems, () => readSecret(env, "SMTP_PASSWORD", readFile));
  const passwordUnreadable = problems.length > 0;

  if (rawHost === undefined) {
    if (
      rawFrom !== undefined ||
      user !== undefined ||
      password !== undefined ||
      passwordUnreadable
    ) {
      problems.push("SMTP_HOST is required when SMTP_FROM, SMTP_USER or SMTP_PASSWORD is set");
    }
    if (problems.length > 0) throw new ConfigError(problems);
    return null;
  }

  const host = parseHostName(rawHost);
  if (host === undefined) problems.push("SMTP_HOST must be an IP address or a hostname");

  const rawPort = envSetting(env, "SMTP_PORT") ?? "587";
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("SMTP_PORT must be an integer between 1 and 65535");
  }

  const rawSecurity = (envSetting(env, "SMTP_SECURITY") ?? "starttls").toLowerCase();
  const security = SMTP_SECURITY_MODES.find((mode) => mode === rawSecurity);
  if (!security) {
    problems.push(`SMTP_SECURITY must be one of ${SMTP_SECURITY_MODES.join(", ")}`);
  } else if (security === "none" && host !== undefined) {
    const loopbackName = isIP(host) === 6 ? `[${host}]` : host.toLowerCase();
    if (!isLoopbackHost(loopbackName)) {
      problems.push("SMTP_SECURITY=none is allowed only when SMTP_HOST is a loopback address");
    }
  }

  if (!passwordUnreadable && (user !== undefined) !== (password !== undefined)) {
    problems.push("SMTP_USER and SMTP_PASSWORD (or SMTP_PASSWORD_FILE) must be set together");
  }

  if (rawFrom === undefined) {
    problems.push("SMTP_FROM is required when SMTP_HOST is set");
  } else if (/[\r\n]/.test(rawFrom) || !rawFrom.includes("@")) {
    problems.push("SMTP_FROM must be an email address or Name <address> on a single line");
  }

  if (
    problems.length > 0 ||
    host === undefined ||
    security === undefined ||
    rawFrom === undefined
  ) {
    throw new ConfigError(problems);
  }
  return { host, port, security, user: user ?? null, password: password ?? null, from: rawFrom };
}

/**
 * Backups: the local directory always exists (default `<dataDir>/backups`). The S3-compatible
 * target is optional and needs its endpoint, bucket, access key id and secret key together.
 */
export function loadBackup(
  env: Env,
  dataDir: string,
  readFile: ReadFile = defaultReadFile,
): BackupConfig {
  const problems: string[] = [];
  const dir = path.resolve(envSetting(env, "BURSAR_BACKUP_DIR") ?? path.join(dataDir, "backups"));
  const rawEndpoint = envSetting(env, "BACKUP_S3_ENDPOINT");
  const bucket = envSetting(env, "BACKUP_S3_BUCKET");
  const accessKeyId = envSetting(env, "BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = collect(problems, () =>
    readSecret(env, "BACKUP_S3_SECRET_KEY", readFile),
  );
  const secretGiven = secretAccessKey !== undefined || problems.length > 0;

  const given = [
    ["BACKUP_S3_ENDPOINT", rawEndpoint !== undefined],
    ["BACKUP_S3_BUCKET", bucket !== undefined],
    ["BACKUP_S3_ACCESS_KEY_ID", accessKeyId !== undefined],
    ["BACKUP_S3_SECRET_KEY (or BACKUP_S3_SECRET_KEY_FILE)", secretGiven],
  ] as const;
  const missing = given.filter(([, isGiven]) => !isGiven).map(([name]) => name);
  if (missing.length === given.length) {
    if (problems.length > 0) throw new ConfigError(problems);
    return { dir, s3: null };
  }
  if (missing.length > 0) {
    problems.push(`The S3 backup target is half configured; also set ${missing.join(", ")}`);
  }

  const endpoint = rawEndpoint
    ? parseHttpsOrigin("BACKUP_S3_ENDPOINT", rawEndpoint, problems)
    : undefined;
  if (bucket !== undefined && !S3_BUCKET_PATTERN.test(bucket)) {
    problems.push(
      "BACKUP_S3_BUCKET must be a valid bucket name (3 to 63 lowercase letters, digits, dots, hyphens)",
    );
  }
  const region = envSetting(env, "BACKUP_S3_REGION") ?? "auto";
  if (!S3_REGION_PATTERN.test(region)) {
    problems.push("BACKUP_S3_REGION must contain only letters, digits and hyphens");
  }
  const prefix = (envSetting(env, "BACKUP_S3_PREFIX") ?? "bursar").replace(/^\/+|\/+$/g, "");
  if (
    !S3_PREFIX_PATTERN.test(prefix) ||
    prefix.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    problems.push(
      "BACKUP_S3_PREFIX must be slash-separated segments of letters, digits, '.', '_' and '-'",
    );
  }

  if (
    problems.length > 0 ||
    endpoint === undefined ||
    bucket === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    throw new ConfigError(problems);
  }
  return { dir, s3: { endpoint, region, bucket, prefix, accessKeyId, secretAccessKey } };
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

  // An empty value counts as unset, so a blank line in .env cannot change a default.
  const setting = (name: string): string | undefined => env[name]?.trim() || undefined;

  const rawPort = setting("BURSAR_PORT") ?? "8080";
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("BURSAR_PORT must be an integer between 1 and 65535");
  }

  // Brackets are URL syntax for IPv6; the socket API needs the bare address.
  const rawHost = setting("BURSAR_HOST") ?? "127.0.0.1";
  const bracketed = /^\[(.*)\]$/.exec(rawHost);
  const host = bracketed ? (bracketed[1] as string) : rawHost;
  if (bracketed ? isIP(host) !== 6 : isIP(host) === 0 && !HOSTNAME_PATTERN.test(host)) {
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

  let timezone: string | undefined;
  const rawTimezone = setting("TZ");
  if (!rawTimezone) {
    problems.push("TZ is required (an IANA timezone such as Europe/Rome)");
  } else {
    try {
      // Keep the canonical name: Intl accepts "europe/rome", which other consumers may not.
      const canonical = new Intl.DateTimeFormat("en", { timeZone: rawTimezone }).resolvedOptions()
        .timeZone;
      if (/^[+-]/.test(canonical)) {
        problems.push(`TZ "${rawTimezone}" is an offset; use an IANA timezone such as Europe/Rome`);
      } else {
        timezone = canonical;
      }
    } catch {
      problems.push(`TZ "${rawTimezone}" is not a valid IANA timezone`);
    }
  }

  const logLevel = setting("BURSAR_LOG_LEVEL") ?? "info";
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

  // Cloudflare Access is optional defence in depth on top of the app login.
  const teamDomain = setting("CF_ACCESS_TEAM_DOMAIN");
  const audience = setting("CF_ACCESS_AUD");
  if (Boolean(teamDomain) !== Boolean(audience)) {
    problems.push("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set together");
  }
  if (teamDomain && !(HOSTNAME_PATTERN.test(teamDomain) && teamDomain.includes("."))) {
    problems.push(
      "CF_ACCESS_TEAM_DOMAIN must be a bare hostname such as <team>.cloudflareaccess.com (no scheme or path)",
    );
  }

  const trustCfConnectingIp = setting("BURSAR_TRUST_CF_CONNECTING_IP")?.toLowerCase() ?? "false";
  if (trustCfConnectingIp !== "true" && trustCfConnectingIp !== "false") {
    problems.push("BURSAR_TRUST_CF_CONNECTING_IP must be true or false");
  }

  const claude = attempt(() => loadClaudeCredential(env, readFile)) ?? null;

  const dataDir = path.resolve(setting("BURSAR_DATA_DIR") ?? "./data");
  const enableBanking = attempt(() => loadEnableBanking(env, readFile)) ?? null;
  const smtp = attempt(() => loadSmtp(env, readFile)) ?? null;
  const backup = attempt(() => loadBackup(env, dataDir, readFile));

  if (problems.length > 0 || !publicUrl || !timezone || !masterKey || !backup) {
    throw new ConfigError(problems);
  }

  return {
    host,
    port,
    publicUrl,
    dataDir,
    timezone,
    logLevel: logLevel as Config["logLevel"],
    masterKey,
    migrationsDir: path.resolve(setting("BURSAR_MIGRATIONS_DIR") ?? "./drizzle"),
    webDistDir: setting("BURSAR_WEB_DIST")
      ? path.resolve(setting("BURSAR_WEB_DIST") as string)
      : null,
    cfAccess: teamDomain && audience ? { teamDomain, audience } : null,
    trustCfConnectingIp: trustCfConnectingIp === "true",
    claude,
    enableBanking,
    smtp,
    backup,
  };
}
