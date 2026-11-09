import { type DestinationStream, type Logger, pino } from "pino";
import type { Config } from "./config";

const CENSOR = "[redacted]";

/** Values shorter than this are not scrubbed: they would match ordinary text. */
const MIN_SCRUB_LENGTH = 8;

/** Field names (and their nested `*.` variants) whose values never reach the log. */
const SECRET_KEYS = [
  "password",
  "token",
  "setupCode",
  "secret",
  "masterKey",
  "claude.value",
  "BURSAR_MASTER_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "EB_PRIVATE_KEY",
  "SMTP_PASSWORD",
  "BACKUP_S3_SECRET_KEY",
  "TUNNEL_TOKEN",
  "headers.cookie",
  'headers["set-cookie"]',
  "headers.authorization",
  'headers["cf-access-jwt-assertion"]',
];

const REDACT_PATHS = SECRET_KEYS.flatMap((key) => [key, `*.${key}`]);

/** The loaded secret values to scrub from every log line, in the encodings they may appear in. */
export function configSecrets(config: Pick<Config, "masterKey" | "claude">): string[] {
  const values = [
    // Unpadded, so the scrubber matches both the padded and the unpadded spelling.
    config.masterKey.toString("base64").replace(/=+$/, ""),
    config.masterKey.toString("base64url"),
    config.masterKey.toString("hex"),
  ];
  if (config.claude) values.push(config.claude.value);
  return values;
}

/** Wraps a destination so every serialized line has the given values replaced. */
function scrubbing(target: DestinationStream, secrets: readonly string[]): DestinationStream {
  const needles = [
    ...new Set(secrets.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])),
  ]
    .filter((needle) => needle.length >= MIN_SCRUB_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (needles.length === 0) return target;
  return {
    write(line: string) {
      let scrubbed = line;
      for (const needle of needles) scrubbed = scrubbed.replaceAll(needle, CENSOR);
      target.write(scrubbed);
    },
  };
}

export function createLogger(
  level: Config["logLevel"],
  destination?: DestinationStream,
  secrets: readonly string[] = [],
): Logger {
  const options = { level, redact: { paths: REDACT_PATHS, censor: CENSOR } };
  const target = destination ?? pino.destination({ dest: process.stdout.fd || 1 });
  return pino(options, scrubbing(target, secrets));
}
