import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button, Select } from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { countryOptions } from "./countries";

export interface CountryStepProps {
  countries: readonly string[];
  value: string;
  onChange(code: string): void;
  onContinue(): void;
}

export function CountryStep({ countries, value, onChange, onContinue }: CountryStepProps) {
  const { t } = useTranslation();
  const { locale } = useFormatters();
  const options = useMemo(
    () => [{ value: "", label: t("connect.country.choose") }, ...countryOptions(countries, locale)],
    [countries, locale, t],
  );
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== "") onContinue();
      }}
    >
      <section>
        <h2 className="font-display text-xl font-bold text-fg">{t("connect.country.title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("connect.country.description")}</p>
      </section>
      <Select
        id="connect-country"
        label={t("connect.country.label")}
        options={options}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="flex justify-end">
        <Button type="submit" disabled={value === ""} data-testid="connect-country-continue">
          {t("connect.country.continue")}
        </Button>
      </div>
    </form>
  );
}
