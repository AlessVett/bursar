import type { SettingsResponse } from "@bursar/shared";
import { useMutation } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../api";
import { feedback } from "../../components/feedback";
import { Button, StatusPill, Switch, TextInput } from "../../components/ui";
import { ReadRow, SectionCard } from "./SectionCard";
import { useSaveSettings } from "./save-settings";
import { useRegisterSection } from "./UnsavedBar";
import { useSectionForm } from "./useSectionForm";

type TestOutcome = "sent" | "smtp_not_configured" | "recipient_missing" | "smtp_failed" | "unknown";

const REFUSAL_CODES = ["smtp_not_configured", "recipient_missing", "smtp_failed"] as const;

function outcomeOf(error: unknown): TestOutcome {
  if (error instanceof ApiError) {
    const known = REFUSAL_CODES.find((code) => code === error.code);
    if (known) return known;
  }
  return "unknown";
}

export function NotificationsSection({
  settings,
  index,
}: {
  settings: SettingsResponse;
  index: number;
}) {
  const { t } = useTranslation();
  const save = useSaveSettings();
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const initial = {
    notificationEmail: settings.values.notificationEmail,
    emailNotifications: settings.values.emailNotifications,
  };
  const form = useSectionForm(initial, (values) =>
    save("notifications", {
      notificationEmail: values.notificationEmail?.trim() || null,
      emailNotifications: values.emailNotifications,
    }),
  );
  useRegisterSection("notifications", form);

  const test = useMutation({
    mutationFn: () => api.sendTestEmail(),
    onSuccess: () => {
      setOutcome("sent");
      feedback(
        t("settings.notifications.test.sentTitle"),
        t("settings.notifications.test.sentDetail", {
          email: settings.values.notificationEmail ?? "",
        }),
      );
    },
    onError: (error) => setOutcome(outcomeOf(error)),
  });

  const { values, errors, editing, saving } = form;
  const smtp = settings.system.smtpConfigured;

  return (
    <SectionCard
      id="settings-notifications"
      title={t("settings.sections.notifications.title")}
      description={t("settings.sections.notifications.description")}
      form={form}
      index={index}
    >
      {editing ? (
        <div>
          <TextInput
            label={t("settings.notifications.email")}
            hint={t("settings.notifications.emailHint")}
            type="email"
            autoComplete="email"
            placeholder={t("settings.notifications.emailPlaceholder")}
            value={values.notificationEmail ?? ""}
            disabled={saving}
            error={errors.notificationEmail}
            onChange={(event) =>
              form.set("notificationEmail", event.target.value === "" ? null : event.target.value)
            }
          />
          <Switch
            label={t("settings.notifications.enabled")}
            description={t("settings.notifications.enabledHint")}
            checked={values.emailNotifications}
            disabled={saving}
            onChange={(checked) => form.set("emailNotifications", checked)}
          />
        </div>
      ) : (
        <dl className="grid gap-4 sm:grid-cols-2">
          <ReadRow label={t("settings.notifications.email")}>
            {values.notificationEmail ?? t("settings.notSet")}
          </ReadRow>
          <ReadRow label={t("settings.notifications.enabledShort")}>
            {values.emailNotifications ? t("settings.on") : t("settings.off")}
          </ReadRow>
        </dl>
      )}

      <div className="mt-5 border-t border-subtle pt-4">
        <h3 className="text-[13px] font-semibold text-fg">
          {t("settings.notifications.smtp.label")}
        </h3>
        <div className="mt-2 flex flex-col items-start gap-2">
          <StatusPill
            tone={smtp ? "positive" : "warning"}
            label={t(
              smtp
                ? "settings.notifications.smtp.configured"
                : "settings.notifications.smtp.notConfigured",
            )}
          />
          {smtp ? null : (
            <p className="text-[13px] text-muted">{t("settings.notifications.smtp.hint")}</p>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            icon={Mail}
            loading={test.isPending}
            disabled={editing}
            title={editing ? t("settings.notifications.test.blocked") : undefined}
            onClick={() => {
              setOutcome(null);
              test.mutate();
            }}
          >
            {t("settings.notifications.test.button")}
          </Button>
        </div>
        {outcome === null ? null : outcome === "sent" ? (
          <output className="mt-2 block text-[13px] text-positive">
            {t("settings.notifications.test.outcomes.sent")}
          </output>
        ) : (
          <p
            role="alert"
            className="mt-2 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning"
          >
            {t(`settings.notifications.test.outcomes.${outcome}`)}
          </p>
        )}
      </div>
    </SectionCard>
  );
}
