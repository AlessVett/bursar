import type { BackupRunItem, SettingsResponse } from "@bursar/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../api";
import { feedback } from "../../components/feedback";
import {
  Button,
  type Column,
  DataTable,
  InlineEmpty,
  RelativeTime,
  StatusPill,
  TextInput,
} from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { isSessionExpired } from "../../lib/query-client";
import { queryKeys } from "../../lib/query-keys";
import { ReadRow, SectionCard } from "./SectionCard";
import { useSaveSettings } from "./save-settings";
import { useRegisterSection } from "./UnsavedBar";
import { useSectionForm } from "./useSectionForm";

const RUNS_SHOWN = 8;
const RUNNING_POLL_MS = 3_000;
const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;
const RUN_TONE = { running: "info", succeeded: "positive", failed: "danger" } as const;

/** "1.8 MB": binary steps, one decimal above bytes, in the panel's number format. */
export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  return `${formatted} ${BYTE_UNITS[unit] ?? "B"}`;
}

export function BackupsSection({ settings, index }: { settings: SettingsResponse; index: number }) {
  const { t } = useTranslation();
  const { locale } = useFormatters();
  const queryClient = useQueryClient();
  const save = useSaveSettings();
  const status = useQuery({
    queryKey: queryKeys.backups,
    queryFn: () => api.backups(),
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === "running") ? RUNNING_POLL_MS : false,
  });
  const initial = { backupTime: settings.values.backupTime };
  const form = useSectionForm(initial, (values) =>
    save("backups", { backupTime: values.backupTime }),
  );
  useRegisterSection("backups", form);

  const run = useMutation({
    mutationFn: () => api.runBackup(),
    onSuccess: () => {
      feedback(t("settings.backups.startedTitle"), t("settings.backups.startedDetail"), "info");
      void queryClient.invalidateQueries({ queryKey: queryKeys.backups });
    },
    onError: (error) => {
      if (isSessionExpired(error)) return;
      if (error instanceof ApiError && error.status === 409) {
        feedback(t("settings.backups.busyTitle"), t("settings.backups.busyDetail"), "warning");
        void queryClient.invalidateQueries({ queryKey: queryKeys.backups });
        return;
      }
      feedback(
        t("settings.backups.runFailedTitle"),
        t("settings.backups.runFailedDetail"),
        "error",
      );
    },
  });

  const data = status.data;
  const running = data?.runs.some((item) => item.status === "running") ?? false;
  const failures = data?.consecutiveFailures ?? 0;

  const columns: Column<BackupRunItem>[] = [
    {
      id: "started",
      header: t("settings.backups.columns.started"),
      cell: (item) => <RelativeTime at={item.startedAt} />,
    },
    {
      id: "trigger",
      header: t("settings.backups.columns.trigger"),
      hideBelow: "sm",
      cell: (item) => t(`settings.backups.triggers.${item.trigger}`),
    },
    {
      id: "status",
      header: t("settings.backups.columns.status"),
      cell: (item) => (
        <StatusPill
          tone={RUN_TONE[item.status]}
          label={t(`settings.backups.statuses.${item.status}`)}
        />
      ),
    },
    {
      id: "size",
      header: t("settings.backups.columns.size"),
      align: "end",
      hideBelow: "md",
      cell: (item) => (item.sizeBytes === null ? "—" : formatBytes(item.sizeBytes, locale)),
    },
    {
      id: "details",
      header: t("settings.backups.columns.details"),
      hideBelow: "lg",
      className: "max-w-[16rem] truncate",
      cell: (item) =>
        item.errorMessage ? <span title={item.errorMessage}>{item.errorMessage}</span> : "—",
    },
  ];

  return (
    <SectionCard
      id="backups"
      title={t("settings.sections.backups.title")}
      description={t("settings.sections.backups.description")}
      form={form}
      index={index}
    >
      {data?.target === "local" ? (
        <div role="note" className="mb-4 flex gap-3 rounded-xl bg-warning-soft p-4 text-warning">
          <TriangleAlert aria-hidden size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold">{t("settings.backups.localOnly.title")}</p>
            <p className="mt-0.5 text-[13px]">{t("settings.backups.localOnly.body")}</p>
          </div>
        </div>
      ) : null}

      <dl className="grid gap-4 sm:grid-cols-3">
        <ReadRow label={t("settings.backups.target")}>
          {data ? (
            <StatusPill
              tone={data.target === "s3" ? "positive" : "warning"}
              label={t(
                data.target === "s3" ? "settings.backups.targetS3" : "settings.backups.targetLocal",
              )}
            />
          ) : (
            "—"
          )}
        </ReadRow>
        <ReadRow label={t("settings.backups.lastSuccess")}>
          {!data ? (
            "—"
          ) : data.lastSuccessAt === null ? (
            t("settings.backups.never")
          ) : (
            <RelativeTime at={data.lastSuccessAt} />
          )}
        </ReadRow>
        <ReadRow label={t("settings.backups.failures")}>
          {!data ? (
            "—"
          ) : failures === 0 ? (
            <StatusPill tone="positive" label={t("settings.backups.failuresNone")} />
          ) : (
            <StatusPill
              tone={failures >= 2 ? "danger" : "warning"}
              label={t("settings.backups.failuresValue", { count: failures })}
            />
          )}
        </ReadRow>
      </dl>

      {form.editing ? (
        <div className="mt-4 max-w-xs">
          <TextInput
            label={t("settings.backups.nightlyTime")}
            hint={t("settings.backups.nightlyTimeHint", { timezone: settings.system.timezone })}
            type="time"
            value={form.values.backupTime}
            disabled={form.saving}
            error={form.errors.backupTime}
            onChange={(event) => form.set("backupTime", event.target.value)}
          />
        </div>
      ) : (
        <dl className="mt-4">
          <ReadRow label={t("settings.backups.nightlyTime")}>{form.values.backupTime}</ReadRow>
        </dl>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          icon={DatabaseBackup}
          loading={run.isPending}
          disabled={running}
          title={running ? t("settings.backups.runBlocked") : undefined}
          onClick={() => run.mutate()}
        >
          {t("settings.backups.runNow")}
        </Button>
        {running ? (
          <output className="text-[13px] text-muted">{t("settings.backups.running")}</output>
        ) : null}
      </div>

      <h3 className="mt-6 text-[13px] font-semibold text-fg">{t("settings.backups.recent")}</h3>
      {status.isError ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl bg-danger-soft p-3 text-danger">
          <p className="text-[13px]">{t("settings.backups.loadFailed")}</p>
          <Button size="sm" variant="secondary" onClick={() => void status.refetch()}>
            {t("shell.retry")}
          </Button>
        </div>
      ) : (
        <div className="mt-2">
          <DataTable
            columns={columns}
            rows={data?.runs.slice(0, RUNS_SHOWN)}
            getRowKey={(item) => item.id}
            loading={status.isPending}
            skeletonRows={3}
            caption={t("settings.backups.caption")}
            empty={
              <InlineEmpty
                icon={DatabaseBackup}
                title={t("settings.backups.empty.title")}
                description={t("settings.backups.empty.body", { time: settings.values.backupTime })}
              />
            }
          />
        </div>
      )}
    </SectionCard>
  );
}
