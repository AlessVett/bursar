import type { AspspSummary } from "@bursar/shared";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Select } from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { BankMark } from "./BankStep";
import { consentEndDate, consentOptions, defaultConsentDays } from "./consent";
import { countryName } from "./countries";

export interface ConsentStepProps {
  bank: AspspSummary;
  /** `settings.values.consentDays`. */
  settingsDays: number;
  submitting: boolean;
  onStart(days: number): void;
  onBack(): void;
}

export function ConsentStep({ bank, settingsDays, submitting, onStart, onBack }: ConsentStepProps) {
  const { t } = useTranslation();
  const formatters = useFormatters();
  const [now] = useState(() => formatters.now());
  const initialDays = defaultConsentDays(bank.maximumConsentDays, settingsDays);
  const [days, setDays] = useState(initialDays);

  const endDateLabel = (count: number) =>
    formatters.localDate(consentEndDate(now, count, formatters.timeZone), "long");
  const options = consentOptions(bank.maximumConsentDays, initialDays).map((count) => ({
    value: String(count),
    label: t("connect.consent.option", { count, date: endDateLabel(count) }),
  }));
  const capped = settingsDays > bank.maximumConsentDays;

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        onStart(days);
      }}
    >
      <section>
        <h2 className="font-display text-xl font-bold text-fg">{t("connect.consent.title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("connect.consent.description")}</p>
      </section>

      <Card padding="md" className="flex items-center gap-3">
        <BankMark bank={bank} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-fg">{bank.name}</p>
          <p className="text-[13px] text-muted">{countryName(bank.country, formatters.locale)}</p>
        </div>
        {bank.beta ? <Badge tone="neutral">{t("connect.bank.beta")}</Badge> : null}
      </Card>

      <Select
        id="connect-duration"
        label={t("connect.consent.durationLabel")}
        options={options}
        value={String(days)}
        onChange={(event) => setDays(Number(event.target.value))}
        hint={
          capped
            ? t("connect.consent.cappedHint", { bank: bank.name, count: bank.maximumConsentDays })
            : undefined
        }
      />
      <p data-testid="consent-end" className="text-sm text-fg">
        {t("connect.consent.endsOn", { date: endDateLabel(days) })}
      </p>

      <div className="flex gap-3 rounded-2xl bg-primary-50 p-4 text-sm text-fg">
        <ShieldCheck
          aria-hidden
          size={20}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-primary"
        />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold">{t("connect.consent.readOnly.title")}</p>
          <p>{t("connect.consent.readOnly.body")}</p>
          <p>{t("connect.consent.readOnly.redirect", { bank: bank.name })}</p>
          <p>{t("connect.consent.readOnly.revoke")}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          {t("connect.back")}
        </Button>
        <Button type="submit" loading={submitting} data-testid="connect-start">
          {t("connect.consent.start", { bank: bank.name })}
        </Button>
      </div>
    </form>
  );
}
