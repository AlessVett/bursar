import type { BursarDb } from "./db";
import { auditLog } from "./db/schema";

export type AuditAction =
  | "connection.create"
  | "connection.renew"
  | "connection.remove"
  | "account.rename"
  | "account.disable"
  | "account.enable"
  | "account.purge"
  | "settings.update"
  | "backup.run";

export interface AuditEntry {
  actor: "user" | "system";
  action: AuditAction;
  /** What the action touched, as a short reference such as `account:12`. Never a secret. */
  target?: string;
  /** Flat, non-sensitive facts about the action. Never secrets, identifiers or amounts. */
  details?: Record<string, string | number | boolean | null>;
}

export class AuditLog {
  constructor(
    private readonly db: BursarDb,
    private readonly now: () => number = Date.now,
  ) {}

  record(entry: AuditEntry): void {
    this.db
      .insert(auditLog)
      .values({
        actor: entry.actor,
        action: entry.action,
        target: entry.target ?? null,
        details: entry.details ? JSON.stringify(entry.details) : null,
        at: this.now(),
      })
      .run();
  }
}
