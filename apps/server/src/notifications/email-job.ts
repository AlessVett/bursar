import { emailPayloadSchema, parsePayload } from "../jobs/types";
import type { JobHandler } from "../jobs/worker";
import type { SettingsStore } from "../settings/store";
import { describeMailError, type Mailer } from "./mailer";
import type { NotificationService } from "./service";
import { panelUrlFor, renderEmail } from "./templates";

export interface EmailJobDeps {
  service: NotificationService;
  /** `null` when SMTP is not configured. */
  mailer: Mailer | null;
  settings: SettingsStore;
  publicUrl: URL;
}

/**
 * Handler of the `notify.email` job. The recipient, the language and the on/off switch are read
 * when the job runs, so a change in the settings applies to messages still waiting in the queue.
 * A delivery failure is rethrown with a reduced message so the queue retries it with backoff; on
 * the last attempt the notification is marked `failed` first. The panel notification itself is
 * never affected by email problems.
 */
export function emailJobHandler(deps: EmailJobDeps): JobHandler {
  return async (job) => {
    const { notificationId } = parsePayload(emailPayloadSchema, job);
    const notification = deps.service.get(notificationId);
    if (!notification) return;

    const { notificationEmail, emailNotifications, locale } = deps.settings.get();
    if (deps.mailer === null || !emailNotifications || notificationEmail === null) {
      deps.service.setEmailStatus(notificationId, "skipped");
      return;
    }

    const { subject, text } = renderEmail({
      event: notification.event,
      locale,
      panelUrl: panelUrlFor(deps.publicUrl, notification.link),
    });
    try {
      await deps.mailer.send({ to: notificationEmail, subject, text });
    } catch (error) {
      const reduced = describeMailError(error);
      if (job.attempts >= job.maxAttempts) {
        deps.service.setEmailStatus(notificationId, "failed", reduced);
      }
      throw new Error(reduced);
    }
    deps.service.setEmailStatus(notificationId, "sent");
  };
}
