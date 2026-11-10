import {
  type NotificationEvent,
  type NotificationItem,
  type NotificationListResponse,
  notificationEventSchema,
  notificationParamsSchema,
} from "@bursar/shared";
import { desc, eq, isNull, sql } from "drizzle-orm";
import type { BursarDb } from "../db";
import { notifications } from "../db/schema";
import type { EventBus } from "../events/bus";
import type { JobQueue } from "../jobs/queue";
import { EMAIL_JOB, emailDedupeKey } from "../jobs/types";
import type { SettingsStore } from "../settings/store";

/** Total delivery attempts for one email (retried after 30 s, 2 min and 8 min). */
export const EMAIL_MAX_ATTEMPTS = 4;

/** Longest `email_error` kept in the database. */
const MAX_EMAIL_ERROR_LENGTH = 200;

export interface RaiseInput {
  event: NotificationEvent;
  dedupeKey: string;
  params: Record<string, string | number>;
  /** A panel path, for example `/accounts/12` or `/settings#backups`. */
  link: string | null;
}

export interface NotificationServiceDeps {
  db: BursarDb;
  queue: JobQueue;
  bus: EventBus;
  settings: SettingsStore;
  /** True when a mailer exists (SMTP configured or injected). */
  emailEnabled: () => boolean;
  now?: () => number;
}

type NotificationRow = typeof notifications.$inferSelect;

export class NotificationService {
  private readonly now: () => number;

  constructor(private readonly deps: NotificationServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Stores a notification unless one with the same dedupe key exists, tells the panel, and queues
   * an email when email is available, switched on in the settings and a recipient is set.
   * Returns the new id, or `null` on a dedupe hit. It opens no transaction of its own, so it can
   * run inside a caller's transaction (Drizzle's top-level `transaction` cannot be nested). If
   * queueing the email fails, the notification stays (marked `skipped`) and the error is rethrown.
   */
  raise(input: RaiseInput): number | null {
    const sendEmail = this.shouldEmail();
    const [row] = this.deps.db
      .insert(notifications)
      .values({
        event: input.event,
        dedupeKey: input.dedupeKey,
        params: JSON.stringify(input.params),
        link: input.link,
        createdAt: this.now(),
        readAt: null,
        emailStatus: sendEmail ? "pending" : "skipped",
      })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
      .all();
    if (!row) return null;
    if (sendEmail) {
      try {
        this.deps.queue.enqueueUnique(
          EMAIL_JOB,
          emailDedupeKey(row.id),
          { notificationId: row.id },
          { maxAttempts: EMAIL_MAX_ATTEMPTS },
        );
      } catch (error) {
        this.setEmailStatus(row.id, "skipped");
        throw error;
      }
    }
    this.deps.bus.publish({ type: "notification.created", id: row.id, event: input.event });
    return row.id;
  }

  list(limit: number): NotificationListResponse {
    const rows = this.deps.db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
      .all();
    const unread = this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(isNull(notifications.readAt))
      .get();
    return {
      items: rows.flatMap((row) => {
        const item = toItem(row);
        return item ? [item] : [];
      }),
      unread: unread?.count ?? 0,
    };
  }

  get(id: number): NotificationItem | null {
    const row = this.deps.db.select().from(notifications).where(eq(notifications.id, id)).get();
    return row ? toItem(row) : null;
  }

  /** Marks one notification read. Idempotent: `true` whenever it exists, `false` when it does not. */
  markRead(id: number): boolean {
    const rows = this.deps.db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, ${this.now()})` })
      .where(eq(notifications.id, id))
      .returning({ id: notifications.id })
      .all();
    return rows.length > 0;
  }

  /** Marks every unread notification read and returns how many changed. */
  markAllRead(): number {
    return this.deps.db
      .update(notifications)
      .set({ readAt: this.now() })
      .where(isNull(notifications.readAt))
      .returning({ id: notifications.id })
      .all().length;
  }

  setEmailStatus(id: number, status: "sent" | "failed" | "skipped", error?: string): void {
    this.deps.db
      .update(notifications)
      .set({
        emailStatus: status,
        emailSentAt: status === "sent" ? this.now() : null,
        emailError: status === "failed" ? (error ?? "").slice(0, MAX_EMAIL_ERROR_LENGTH) : null,
      })
      .where(eq(notifications.id, id))
      .run();
  }

  private shouldEmail(): boolean {
    if (!this.deps.emailEnabled()) return false;
    const { emailNotifications, notificationEmail } = this.deps.settings.get();
    return emailNotifications && notificationEmail !== null;
  }
}

/** Rows with an event this build does not know (for example from a newer version) are hidden. */
function toItem(row: NotificationRow): NotificationItem | null {
  const event = notificationEventSchema.safeParse(row.event);
  if (!event.success) return null;
  return {
    id: row.id,
    event: event.data,
    params: parseParams(row.params),
    link: row.link,
    createdAt: row.createdAt,
    readAt: row.readAt,
  };
}

function parseParams(raw: string): Record<string, string | number> {
  try {
    const parsed = notificationParamsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
