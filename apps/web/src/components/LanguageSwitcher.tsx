import { useTranslation } from "react-i18next";
import { type Language, setLanguage } from "../i18n";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <label className="text-sm text-muted">
      {t("common.language")}{" "}
      <select
        className="rounded-md border border-muted bg-surface px-2 py-1 text-fg"
        value={i18n.language}
        onChange={(event) => setLanguage(event.target.value as Language)}
      >
        <option value="it">Italiano</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
