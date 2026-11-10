import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailDedupeKey } from "../jobs/types";
import { createNotificationFixture, type NotificationFixture } from "../test/notifications";
import { notificationKeys } from "./keys";
import type { RaiseInput } from "./service";

const expiring = (overrides: Partial<RaiseInput> = {}): RaiseInput => ({
  event: "consent_expiring",
  dedupeKey: notificationKeys.consentExpiring(1, 1_800_000_000_000, 14),
  params: { bankName: "Banca Esempio", days: 14 },
  link: "/accounts",
  ...overrides,
});

describe("notificationKeys", () => {
  it("builds stable strings", () => {
    expect(notificationKeys.consentExpiring(7, 1_800_000_000_000, 14)).toBe(
      "consent-expiring:7:1800000000000:14",
    );
    expect(notificationKeys.consentExpiring(7, 1_800_000_000_000, 3)).toBe(
      "consent-expiring:7:1800000000000:3",
    );
    expect(notificationKeys.consentExpired(7, 1_800_000_000_000)).toBe(
      "consent-expired:7:1800000000000",
    );
    expect(notificationKeys.connectionError(7, 1_700_000_000_000)).toBe(
      "connection-error:7:1700000000000",
    );
    expect(notificationKeys.syncFailing(4, "2026-11-01")).toBe("sync-failing:4:2026-11-01");
    expect(notificationKeys.syncFailing(4, "never")).toBe("sync-failing:4:never");
    expect(notificationKeys.backupFailing("2026-11-09")).toBe("backup-failing:2026-11-09");
  });

  it("gives a renewed consent a new key and keeps thresholds apart", () => {
    const before = notificationKeys.consentExpiring(1, 1_800_000_000_000, 14);
    expect(notificationKeys.consentExpiring(1, 1_810_000_000_000, 14)).not.toBe(before);
    expect(notificationKeys.consentExpiring(1, 1_800_000_000_000, 3)).not.toBe(before);
  });
});

describe("NotificationService", () => {
  let f: NotificationFixture;

  beforeEach(() => {
    f = createNotificationFixture();
  });
  afterEach(() => f.dispose());

  it("stores a notification and tells the panel", () => {
    const id = f.service.raise(expiring());
    expect(id).toBeGreaterThan(0);
    expect(f.service.list(10)).toEqual({
      items: [
        {
          id,
          event: "consent_expiring",
          params: { bankName: "Banca Esempio", days: 14 },
          link: "/accounts",
          createdAt: f.clock.now,
          readAt: null,
        },
      ],
      unread: 1,
    });
    expect(f.events).toEqual([{ type: "notification.created", id, event: "consent_expiring" }]);
  });

  it("returns null for a repeated dedupe key and publishes nothing more", () => {
    expect(f.service.raise(expiring())).not.toBeNull();
    expect(f.service.raise(expiring({ params: { bankName: "Other", days: 13 } }))).toBeNull();
    expect(f.service.list(10).items).toHaveLength(1);
    expect(f.events).toHaveLength(1);
    expect(f.queue.findActive(emailDedupeKey(1))).not.toBeNull();
    expect(f.service.raise(expiring({ dedupeKey: "other" }))).not.toBeNull();
  });

  it("queues one email job when email is available, switched on and a recipient is set", () => {
    const id = f.service.raise(expiring());
    if (id === null) throw new Error("expected a notification");
    expect(f.queue.findActive(emailDedupeKey(id))).toMatchObject({ status: "queued" });
    expect(f.emailRow(id)).toEqual({ status: "pending", sentAt: null, error: null });
    const job = f.queue.claimNext();
    expect(job).toMatchObject({
      type: "notify.email",
      payload: { notificationId: id },
      maxAttempts: 4,
    });
  });

  it("does not queue an email when no mailer is configured", () => {
    f.mail.enabled = false;
    const id = f.service.raise(expiring());
    if (id === null) throw new Error("expected a notification");
    expect(f.queue.findActive(emailDedupeKey(id))).toBeNull();
    expect(f.emailRow(id)?.status).toBe("skipped");
  });

  it("does not queue an email when the setting is off or the recipient is missing", () => {
    f.settings.update({ emailNotifications: false });
    const off = f.service.raise(expiring({ dedupeKey: "off" }));
    f.settings.update({ emailNotifications: true, notificationEmail: null });
    const noRecipient = f.service.raise(expiring({ dedupeKey: "no-recipient" }));
    for (const id of [off, noRecipient]) {
      if (id === null) throw new Error("expected a notification");
      expect(f.queue.findActive(emailDedupeKey(id))).toBeNull();
      expect(f.emailRow(id)?.status).toBe("skipped");
    }
    expect(f.service.list(10).items).toHaveLength(2);
  });

  it("joins a transaction the caller already opened", () => {
    let committed: number | null = null;
    f.t.sqlite.transaction(() => {
      committed = f.service.raise(expiring({ dedupeKey: "inside-commit" }));
    })();
    expect(committed).not.toBeNull();
    expect(f.service.list(10).items).toHaveLength(1);

    expect(() =>
      f.t.sqlite.transaction(() => {
        f.service.raise(expiring({ dedupeKey: "inside-rollback" }));
        throw new Error("caller failed");
      })(),
    ).toThrow("caller failed");
    expect(f.service.list(10).items).toHaveLength(1);
    expect(f.queue.findActive(emailDedupeKey(2))).toBeNull();
  });

  it("keeps the notification, marked skipped, when the email job cannot be queued", () => {
    vi.spyOn(f.queue, "enqueueUnique").mockImplementation(() => {
      throw new Error("database is busy");
    });
    expect(() => f.service.raise(expiring())).toThrow("database is busy");
    const { items } = f.service.list(10);
    expect(items).toHaveLength(1);
    expect(f.emailRow(items[0]?.id ?? 0)?.status).toBe("skipped");
  });

  it("lists newest first, limited, with the total unread count", () => {
    for (let n = 1; n <= 5; n += 1) {
      f.clock.now += 1_000;
      f.service.raise(expiring({ dedupeKey: `k${n}`, params: { n } }));
    }
    const { items, unread } = f.service.list(3);
    expect(items.map((item) => item.params.n)).toEqual([5, 4, 3]);
    expect(unread).toBe(5);
  });

  it("breaks a tie on the creation time by id", () => {
    f.service.raise(expiring({ dedupeKey: "a", params: { n: 1 } }));
    f.service.raise(expiring({ dedupeKey: "b", params: { n: 2 } }));
    expect(f.service.list(10).items.map((item) => item.params.n)).toEqual([2, 1]);
  });

  it("marks one notification read, idempotently, and reports a missing one", () => {
    const id = f.service.raise(expiring());
    if (id === null) throw new Error("expected a notification");
    f.clock.now += 5_000;
    const readAt = f.clock.now;
    expect(f.service.markRead(id)).toBe(true);
    f.clock.now += 5_000;
    expect(f.service.markRead(id)).toBe(true);
    expect(f.service.get(id)?.readAt).toBe(readAt);
    expect(f.service.list(10).unread).toBe(0);
    expect(f.service.markRead(9_999)).toBe(false);
  });

  it("marks everything read and counts only the notifications that changed", () => {
    const first = f.service.raise(expiring({ dedupeKey: "a" }));
    f.service.raise(expiring({ dedupeKey: "b" }));
    f.service.raise(expiring({ dedupeKey: "c" }));
    if (first === null) throw new Error("expected a notification");
    f.service.markRead(first);
    expect(f.service.markAllRead()).toBe(2);
    expect(f.service.markAllRead()).toBe(0);
    expect(f.service.list(10).unread).toBe(0);
  });

  it("records the email outcome", () => {
    const id = f.service.raise(expiring());
    if (id === null) throw new Error("expected a notification");
    f.clock.now += 1_000;
    f.service.setEmailStatus(id, "sent");
    expect(f.emailRow(id)).toEqual({ status: "sent", sentAt: f.clock.now, error: null });
    f.service.setEmailStatus(id, "failed", "x".repeat(500));
    expect(f.emailRow(id)).toMatchObject({ status: "failed", sentAt: null });
    expect(f.emailRow(id)?.error).toHaveLength(200);
    f.service.setEmailStatus(id, "skipped");
    expect(f.emailRow(id)).toEqual({ status: "skipped", sentAt: null, error: null });
  });

  it("returns null for an unknown id", () => {
    expect(f.service.get(123)).toBeNull();
  });

  it("tolerates unreadable params and hides events this build does not know", () => {
    f.t.sqlite
      .prepare(
        `INSERT INTO notifications (event, dedupe_key, params, link, created_at, email_status)
         VALUES ('consent_expired', 'bad-params', 'not json', NULL, ?, 'skipped'),
                ('report_ready', 'future-event', '{}', NULL, ?, 'skipped')`,
      )
      .run(f.clock.now, f.clock.now);
    const { items } = f.service.list(10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ event: "consent_expired", params: {}, link: null });
  });
});
