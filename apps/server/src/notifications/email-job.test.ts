import { notificationEventSchema } from "@bursar/shared";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMAIL_JOB } from "../jobs/types";
import { type JobHandler, JobWorker } from "../jobs/worker";
import {
  createNotificationFixture,
  type NotificationFixture,
  TEST_PUBLIC_URL,
  TEST_RECIPIENT,
} from "../test/notifications";
import { emailJobHandler } from "./email-job";
import { notificationKeys } from "./keys";
import type { Mailer } from "./mailer";
import { renderEmail } from "./templates";

const logger = pino({ level: "silent" });
const HOUR_MS = 3_600_000;

describe("emailJobHandler", () => {
  let f: NotificationFixture;

  const worker = (mailer: Mailer | null = f.mailer): JobWorker =>
    new JobWorker(
      f.queue,
      new Map<string, JobHandler>([
        [
          EMAIL_JOB,
          emailJobHandler({
            service: f.service,
            mailer,
            settings: f.settings,
            publicUrl: TEST_PUBLIC_URL,
          }),
        ],
      ]),
      logger,
    );

  const raise = (params: Record<string, string | number> = { bankName: "Banca Esempio" }) => {
    const id = f.service.raise({
      event: "consent_expiring",
      dedupeKey: notificationKeys.consentExpiring(12, 1_800_000_000_000, 3),
      params,
      link: "/accounts/12",
    });
    if (id === null) throw new Error("expected a notification");
    return id;
  };

  beforeEach(() => {
    f = createNotificationFixture();
  });
  afterEach(() => f.dispose());

  it("sends the email, in the configured language, and marks it sent", async () => {
    const id = raise();
    f.settings.update({ locale: "en" });
    f.clock.now += 2_000;
    expect(await worker().runOnce()).toBe(true);
    const expected = renderEmail({
      event: "consent_expiring",
      locale: "en",
      panelUrl: "https://bursar.example.test/accounts/12",
    });
    expect(f.mailer.sent).toEqual([{ to: TEST_RECIPIENT, ...expected }]);
    expect(f.emailRow(id)).toEqual({ status: "sent", sentAt: f.clock.now, error: null });
  });

  it("leaks no parameter, amount, bank name or other digit into any message", async () => {
    const leakyParams = {
      bankName: "Banca Esempio",
      accountName: "Conto Casa",
      amount: 123456,
      days: 3,
      iban: "IT60X0542811101000000123456",
    };
    const w = worker();
    for (const locale of ["it", "en"] as const) {
      f.settings.update({ locale });
      for (const event of notificationEventSchema.options) {
        f.service.raise({
          event,
          dedupeKey: `${event}:${locale}`,
          params: leakyParams,
          link: "/accounts/12",
        });
        await w.runOnce();
      }
    }
    expect(f.mailer.sent).toHaveLength(10);
    for (const { subject, text, to } of f.mailer.sent) {
      expect(to).toBe(TEST_RECIPIENT);
      const everything = `${subject}\n${text}`;
      for (const secret of ["Banca", "Esempio", "Conto Casa", "123456", "IT60", "iban", "€"]) {
        expect(everything).not.toContain(secret);
      }
      expect(text).toContain("\nhttps://bursar.example.test/accounts/12\n");
      const withoutUrl = everything.replace("https://bursar.example.test/accounts/12", "");
      expect(withoutUrl).not.toMatch(/\d/);
    }
  });

  it("retries a failed delivery with a reduced error and succeeds on the next attempt", async () => {
    const id = raise();
    const w = worker();
    f.mailer.failNext = Object.assign(new Error("535 bad credentials for secret-user"), {
      code: "EAUTH",
      responseCode: 535,
    });
    await w.runOnce();
    const jobId = f.queue.findActive(`email:${id}`)?.id;
    if (jobId === undefined) throw new Error("expected the job to be queued again");
    expect(f.queue.get(jobId)).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "SMTP delivery failed (EAUTH, 535)",
    });
    expect(f.emailRow(id)?.status).toBe("pending");
    expect(await w.runOnce()).toBe(false);

    f.clock.now += HOUR_MS;
    await w.runOnce();
    expect(f.queue.get(jobId)?.status).toBe("succeeded");
    expect(f.emailRow(id)?.status).toBe("sent");
    expect(f.mailer.sent).toHaveLength(1);
  });

  it("marks the notification failed on the last attempt and keeps it in the panel", async () => {
    const id = raise();
    const jobId = f.queue.findActive(`email:${id}`)?.id;
    if (jobId === undefined) throw new Error("expected the job to be queued");
    const w = worker();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      f.mailer.failNext = Object.assign(new Error("password hunter2 rejected"), {
        code: "ECONNECTION",
      });
      f.clock.now += HOUR_MS;
      await w.runOnce();
      expect(f.emailRow(id)?.status).toBe(attempt < 4 ? "pending" : "failed");
    }
    expect(f.queue.get(jobId)).toMatchObject({
      status: "failed",
      attempts: 4,
      lastError: "SMTP delivery failed (ECONNECTION)",
    });
    expect(f.emailRow(id)).toEqual({
      status: "failed",
      sentAt: null,
      error: "SMTP delivery failed (ECONNECTION)",
    });
    expect(f.service.get(id)).not.toBeNull();
    expect(f.mailer.sent).toHaveLength(0);
  });

  it("skips when there is no mailer, no recipient or the setting was switched off", async () => {
    const noMailer = raise();
    await worker(null).runOnce();
    expect(f.emailRow(noMailer)?.status).toBe("skipped");

    const noRecipient = f.service.raise({
      event: "consent_expired",
      dedupeKey: "a",
      params: {},
      link: null,
    });
    f.settings.update({ notificationEmail: null });
    await worker().runOnce();
    expect(f.emailRow(noRecipient ?? 0)?.status).toBe("skipped");

    f.settings.update({ notificationEmail: TEST_RECIPIENT });
    const switchedOff = f.service.raise({
      event: "consent_expired",
      dedupeKey: "b",
      params: {},
      link: null,
    });
    f.settings.update({ emailNotifications: false });
    await worker().runOnce();
    expect(f.emailRow(switchedOff ?? 0)?.status).toBe("skipped");
    expect(f.mailer.sent).toHaveLength(0);
  });

  it("falls back to the panel home for a link that is not a panel path", async () => {
    f.service.raise({
      event: "connection_error",
      dedupeKey: "odd-link",
      params: {},
      link: "https://evil.example.test/phish",
    });
    await worker().runOnce();
    expect(f.mailer.sent[0]?.text).toContain("\nhttps://bursar.example.test/\n");
    expect(f.mailer.sent[0]?.text).not.toContain("evil");
  });

  it("completes quietly when the notification no longer exists", async () => {
    const jobId = f.queue.enqueue(EMAIL_JOB, { notificationId: 9_999 });
    await worker().runOnce();
    expect(f.queue.get(jobId)?.status).toBe("succeeded");
    expect(f.mailer.sent).toHaveLength(0);
  });

  it("fails a job with an invalid payload permanently", async () => {
    const jobId = f.queue.enqueue(EMAIL_JOB, { notificationId: "twelve" });
    await worker().runOnce();
    expect(f.queue.get(jobId)?.status).toBe("failed");
    expect(f.mailer.sent).toHaveLength(0);
  });
});
