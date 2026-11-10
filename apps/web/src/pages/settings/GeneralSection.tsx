import { formatAbsolute, formatMoney, formatRelative, type SettingsResponse } from "@bursar/shared";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "../../components/ui";
import { type Language, setLanguage } from "../../i18n";
import { localeFor } from "../../lib/format";
import { ReadRow, SectionCard } from "./SectionCard";
import { useSaveSettings } from "./save-settings";
import { useRegisterSection } from "./UnsavedBar";
import { useSectionForm } from "./useSectionForm";

/** Countries Enable Banking serves in Europe. The connect wizard narrows this by what the application allows. */
const COUNTRY_CODES = [
  "AT",
  "BE",
  "BG",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
] as const;

const PREVIEW_AMOUNT_MINOR = 123_456;
const PREVIEW_AGE_MS = 2 * 3_600_000;

function isLanguage(value: string): value is Language {
  return value === "it" || value === "en";
}

function regionName(code: string, language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Live preview of a date, a relative time and an amount in the chosen language. */
function Preview({ language, timeZone }: { language: Language; timeZone: string }) {
  const { t } = useTranslation();
  const locale = localeFor(language);
  const reference = useMemo(() => Date.now(), []);
  const rows = [
    ["date", formatAbsolute(reference, locale, timeZone)],
    ["relative", formatRelative(reference - PREVIEW_AGE_MS, reference, locale, timeZone)],
    ["amount", formatMoney(PREVIEW_AMOUNT_MINOR, "EUR", locale)],
  ] as const;
  return (
    <div className="mt-5 rounded-xl bg-surface-2 p-4" aria-live="polite">
      <h3 className="text-[13px] font-semibold text-fg">{t("settings.general.preview.title")}</h3>
      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        {rows.map(([id, value]) => (
          <ReadRow key={id} label={t(`settings.general.preview.${id}`)}>
            {value}
          </ReadRow>
        ))}
      </dl>
      <p className="mt-3 text-[13px] text-muted">{t("settings.general.preview.hint")}</p>
    </div>
  );
}

export function GeneralSection({ settings, index }: { settings: SettingsResponse; index: number }) {
  const { t, i18n } = useTranslation();
  const save = useSaveSettings();
  const initial = { locale: settings.values.locale, country: settings.values.country };
  const form = useSectionForm(initial, (values) =>
    save("general", { locale: values.locale, country: values.country }, () =>
      setLanguage(values.locale),
    ),
  );
  useRegisterSection("general", form);

  const { values, errors, editing, saving } = form;
  const timeZone = settings.system.timezone;
  const codes: readonly string[] =
    values.country !== null && !(COUNTRY_CODES as readonly string[]).includes(values.country)
      ? [...COUNTRY_CODES, values.country]
      : COUNTRY_CODES;
  const collator = new Intl.Collator(i18n.language);
  const countryOptions = [
    { value: "", label: t("settings.notSet") },
    ...codes
      .map((code) => ({ value: code, label: regionName(code, i18n.language) }))
      .sort((a, b) => collator.compare(a.label, b.label)),
  ];

  return (
    <SectionCard
      id="settings-general"
      title={t("settings.sections.general.title")}
      description={t("settings.sections.general.description")}
      form={form}
      index={index}
    >
      {editing ? (
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Select
            label={t("settings.general.language")}
            value={values.locale}
            disabled={saving}
            error={errors.locale}
            options={[
              { value: "it", label: t("settings.general.languages.it") },
              { value: "en", label: t("settings.general.languages.en") },
            ]}
            onChange={(event) => {
              if (isLanguage(event.target.value)) form.set("locale", event.target.value);
            }}
          />
          <Select
            label={t("settings.general.country")}
            value={values.country ?? ""}
            disabled={saving}
            error={errors.country}
            options={countryOptions}
            onChange={(event) =>
              form.set("country", event.target.value === "" ? null : event.target.value)
            }
          />
        </div>
      ) : (
        <dl className="grid gap-4 sm:grid-cols-2">
          <ReadRow label={t("settings.general.language")}>
            {t(`settings.general.languages.${values.locale}`)}
          </ReadRow>
          <ReadRow label={t("settings.general.country")}>
            {values.country === null
              ? t("settings.notSet")
              : regionName(values.country, i18n.language)}
          </ReadRow>
        </dl>
      )}
      <dl className="mt-4">
        <ReadRow label={t("settings.general.timezone")}>
          <span>{timeZone}</span>
          <span className="mt-0.5 block text-[13px] text-muted">
            {t("settings.general.timezoneNote")}
          </span>
        </ReadRow>
      </dl>
      <Preview language={values.locale} timeZone={timeZone} />
    </SectionCard>
  );
}
