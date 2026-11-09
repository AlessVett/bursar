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
