import type { BankStatusResponse, SettingsResponse } from "@bursar/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button, Select, StatusPill, TextInput } from "../../components/ui";
import { queryKeys } from "../../lib/query-keys";
import { ReadRow, SectionCard } from "./SectionCard";
import { useSaveSettings } from "./save-settings";
import { useRegisterSection } from "./UnsavedBar";
import { useSectionForm } from "./useSectionForm";

const CAP_OPTIONS = [1, 2, 3, 4] as const;

function toNumber(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function StatusDetails({ status }: { status: BankStatusResponse }) {
  const { t } = useTranslation();
  if (!status.configured) {
    return (
      <div className="mt-2 flex flex-col items-start gap-2">
        <StatusPill tone="neutral" label={t("settings.banking.status.notConfigured")} />
        <p className="text-[13px] text-muted">{t("settings.banking.status.notConfiguredHint")}</p>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-2">
        {status.environment !== null ? (
          <StatusPill
            tone={status.environment === "PRODUCTION" ? "positive" : "info"}
            label={t(`settings.banking.status.environment.${status.environment}`)}
          />
        ) : null}
        {status.active === null ? null : (
          <StatusPill
            tone={status.active ? "positive" : "danger"}
            label={t(
              status.active ? "settings.banking.status.active" : "settings.banking.status.inactive",
            )}
          />
        )}
        {status.redirectUrlAllowed === null ? null : (
          <StatusPill
            tone={status.redirectUrlAllowed ? "positive" : "warning"}
            label={t(
              status.redirectUrlAllowed
                ? "settings.banking.status.redirectAllowed"
                : "settings.banking.status.redirectBlocked",
            )}
          />
        )}
      </div>
      {status.redirectUrlAllowed === false ? (
        <p className="mt-2 text-[13px] text-muted">
          {t("settings.banking.status.redirectBlockedHint")}
        </p>
      ) : null}
      {status.error !== null ? (
        <p className="mt-2 text-[13px] text-muted">{t("settings.banking.status.unreachable")}</p>
      ) : null}
    </div>
  );
}

function BankStatus() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: queryKeys.bankStatus,
    queryFn: () => api.bankStatus(),
    staleTime: 60_000,
  });
  return (
    <div className="mt-5 border-t border-subtle pt-4">
      <h3 className="text-[13px] font-semibold text-fg">{t("settings.banking.status.title")}</h3>
      {query.isPending ? (
        <p aria-busy="true" className="mt-2 text-[13px] text-muted">
          {t("settings.banking.status.loading")}
        </p>
      ) : query.isError ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-[13px] text-muted">{t("settings.banking.status.failed")}</p>
          <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
            {t("shell.retry")}
          </Button>
        </div>
      ) : (
        <StatusDetails status={query.data} />
      )}
    </div>
  );
}

export function BankingSection({ settings, index }: { settings: SettingsResponse; index: number }) {
  const { t } = useTranslation();
  const save = useSaveSettings();
  const initial = {
    consentDays: settings.values.consentDays,
    backgroundSyncCap: settings.values.backgroundSyncCap,
    dailySyncTime: settings.values.dailySyncTime,
  };
  const form = useSectionForm(initial, (values) => save("banking", values));
  useRegisterSection("banking", form);

  const { values, errors, editing, saving } = form;
  const timezone = settings.system.timezone;

  return (
    <SectionCard
      id="settings-banking"
      title={t("settings.sections.banking.title")}
      description={t("settings.sections.banking.description")}
      form={form}
      index={index}
    >
      {editing ? (
        <div className="grid gap-x-6 sm:grid-cols-2">
          <TextInput
            label={t("settings.banking.consentDays")}
            hint={t("settings.banking.consentDaysHint")}
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            step={1}
            value={String(values.consentDays)}
            disabled={saving}
            error={errors.consentDays}
            onChange={(event) => form.set("consentDays", toNumber(event.target.value))}
          />
          <Select
            label={t("settings.banking.syncCap")}
            hint={t("settings.banking.syncCapHint")}
            value={String(values.backgroundSyncCap)}
            disabled={saving}
            error={errors.backgroundSyncCap}
            options={CAP_OPTIONS.map((cap) => ({ value: String(cap), label: String(cap) }))}
            onChange={(event) => form.set("backgroundSyncCap", toNumber(event.target.value))}
          />
          <TextInput
            label={t("settings.banking.dailyTime")}
            hint={t("settings.banking.dailyTimeHint", { timezone })}
            type="time"
            value={values.dailySyncTime}
            disabled={saving}
            error={errors.dailySyncTime}
            onChange={(event) => form.set("dailySyncTime", event.target.value)}
          />
        </div>
      ) : (
        <dl className="grid gap-4 sm:grid-cols-3">
          <ReadRow label={t("settings.banking.short.consentDays")}>
            {t("settings.banking.consentDaysValue", { count: values.consentDays })}
          </ReadRow>
          <ReadRow label={t("settings.banking.short.syncCap")}>
            {t("settings.banking.syncCapValue", { count: values.backgroundSyncCap })}
          </ReadRow>
          <ReadRow label={t("settings.banking.short.dailyTime")}>{values.dailySyncTime}</ReadRow>
        </dl>
      )}
      <BankStatus />
    </SectionCard>
  );
}
