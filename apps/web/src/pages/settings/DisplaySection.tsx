import type { SettingsResponse } from "@bursar/shared";
import { useTranslation } from "react-i18next";
import { Switch } from "../../components/ui";
import { ReadRow, SectionCard } from "./SectionCard";
import { useSaveSettings } from "./save-settings";
import { useRegisterSection } from "./UnsavedBar";
import { useSectionForm } from "./useSectionForm";

export function DisplaySection({ settings, index }: { settings: SettingsResponse; index: number }) {
  const { t } = useTranslation();
  const save = useSaveSettings();
  const initial = { highlightNegativeNet: settings.values.highlightNegativeNet };
  const form = useSectionForm(initial, (values) =>
    save("display", { highlightNegativeNet: values.highlightNegativeNet }),
  );
  useRegisterSection("display", form);

  return (
    <SectionCard
      id="settings-display"
      title={t("settings.sections.display.title")}
      description={t("settings.sections.display.description")}
      form={form}
      index={index}
    >
      {form.editing ? (
        <Switch
          label={t("settings.display.highlight")}
          description={t("settings.display.highlightHint")}
          checked={form.values.highlightNegativeNet}
          disabled={form.saving}
          onChange={(checked) => form.set("highlightNegativeNet", checked)}
        />
      ) : (
        <dl>
          <ReadRow label={t("settings.display.highlight")}>
            {form.values.highlightNegativeNet ? t("settings.on") : t("settings.off")}
          </ReadRow>
        </dl>
      )}
      <p className="text-[13px] text-muted">{t("settings.display.themeHint")}</p>
    </SectionCard>
  );
}
