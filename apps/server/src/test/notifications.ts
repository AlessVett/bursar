import type { ServerEvent } from "@bursar/shared";
import { eq } from "drizzle-orm";
import { notifications } from "../db/schema";
import { EventBus } from "../events/bus";
import { JobQueue } from "../jobs/queue";
import { MemoryMailer } from "../notifications/mailer";
import { NotificationService } from "../notifications/service";
import { SettingsStore } from "../settings/store";
import { createTestDatabase, type TestDatabase } from "./db";

export const TEST_PUBLIC_URL = new URL("https://bursar.example.test");
export const TEST_RECIPIENT = "owner@example.test";

export interface NotificationFixture {
  t: TestDatabase;
  queue: JobQueue;
  bus: EventBus;
  settings: SettingsStore;
  service: NotificationService;
  mailer: MemoryMailer;
  /** Every event published on the bus. */
  events: ServerEvent[];
  /** Mutable clock shared by the queue and the service. */
  clock: { now: number };
  /** Mutable switch behind `emailEnabled` (true: a mailer is configured). */
  mail: { enabled: boolean };
  emailRow(id: number): { status: string; sentAt: number | null; error: string | null } | null;
  dispose(): void;
}

/** Real database, queue, bus, settings and service; email enabled with a recipient set. */
export function createNotificationFixture(): NotificationFixture {
  const t = createTestDatabase();
  const clock = { now: 1_700_000_000_000 };
  const mail = { enabled: true };
  const now = () => clock.now;
  const queue = new JobQueue(t.sqlite, now);
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const settings = new SettingsStore(t.db, now);
  settings.update({ notificationEmail: TEST_RECIPIENT });
  const service = new NotificationService({
    db: t.db,
    queue,
    bus,
    settings,
    emailEnabled: () => mail.enabled,
    now,
  });
  return {
    t,
    queue,
    bus,
    settings,
    service,
    mailer: new MemoryMailer(),
    events,
    clock,
    mail,
    emailRow: (id) => {
      const row = t.db.select().from(notifications).where(eq(notifications.id, id)).get();
      return row
        ? { status: row.emailStatus, sentAt: row.emailSentAt, error: row.emailError }
        : null;
    },
    dispose: () => t.dispose(),
  };
}
