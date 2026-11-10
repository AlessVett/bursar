import nodemailer, { type SMTPTransportOptions } from "nodemailer";
import type { Config } from "../config";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  /** Connects and authenticates without sending anything. */
  verify(): Promise<void>;
}

/**
 * Maps the three security modes to nodemailer options:
 * - `tls`: implicit TLS (usually port 465);
 * - `starttls`: the upgrade is mandatory, a message is never sent in clear text;
 * - `none`: no encryption (the configuration only allows it for a loopback host).
 */
export function smtpTransportOptions(smtp: NonNullable<Config["smtp"]>): SMTPTransportOptions {
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: smtp.security === "starttls",
    ignoreTLS: smtp.security === "none",
    auth:
      smtp.user !== null && smtp.password !== null
        ? { user: smtp.user, pass: smtp.password }
        : undefined,
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

export function createSmtpMailer(smtp: NonNullable<Config["smtp"]>): Mailer {
  const transport = nodemailer.createTransport(smtpTransportOptions(smtp));
  return {
    async send(message) {
      await transport.sendMail({
        from: smtp.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
    async verify() {
      await transport.verify();
    },
  };
}

/** Collects messages in memory: used by tests and by the QA server (no network). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** The next `send` or `verify` rejects with this error, then the mailer works again. */
  failNext?: Error;

  async send(message: MailMessage): Promise<void> {
    this.throwIfFailing();
    this.sent.push({ ...message });
  }

  async verify(): Promise<void> {
    this.throwIfFailing();
  }

  private throwIfFailing(): void {
    const error = this.failNext;
    if (error) {
      this.failNext = undefined;
      throw error;
    }
  }
}

/**
 * A message that is safe to store, log and return: only the nodemailer error code and the SMTP
 * status number. The server's response text (it can contain addresses or account names) and
 * anything that could hold credentials are dropped.
 */
export function describeMailError(error: unknown): string {
  const details: string[] = [];
  if (typeof error === "object" && error !== null) {
    const { code, responseCode } = error as { code?: unknown; responseCode?: unknown };
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) details.push(code);
    if (typeof responseCode === "number" && Number.isInteger(responseCode)) {
      details.push(String(responseCode));
    }
  }
  return details.length > 0
    ? `SMTP delivery failed (${details.join(", ")})`
    : "SMTP delivery failed";
}
