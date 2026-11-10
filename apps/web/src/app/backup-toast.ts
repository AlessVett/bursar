import { feedback } from "../components/feedback";
import i18n from "../i18n";

/**
 * The toast for a `backup.finished` live event. It uses the global i18n instance, not a hook,
 * because it is called from the event stream handler, outside any component.
 */
export function announceBackupFinished(status: "succeeded" | "failed"): void {
  if (status === "succeeded") {
    feedback(i18n.t("settings.backups.finishedTitle"), i18n.t("settings.backups.finishedDetail"));
    return;
  }
  feedback(
    i18n.t("settings.backups.failedTitle"),
    i18n.t("settings.backups.failedDetail"),
    "error",
  );
}
