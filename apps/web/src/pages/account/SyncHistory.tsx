import type { SyncRunItem } from "@bursar/shared";
import { History } from "lucide-react";
import { useTranslation } from "react-i18next";
import { InlineEmpty, RelativeTime, StatusPill } from "../../components/ui";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { errorLabel, skipReasonLabel } from "./labels";

const STATUS_TONE = {
  running: "info",
  succeeded: "positive",
  failed: "danger",
  skipped: "neutral",
} as const;

/** The sync history of one account: when, why it ran, how it ended and what changed. */
export function SyncHistory({ runs }: { runs: SyncRunItem[] }) {
  const { t } = useTranslation();

  const changes = (run: SyncRunItem): string => {
    const parts = [
      run.inserted > 0 ? t("account.sync.inserted", { count: run.inserted }) : null,
      run.updated > 0 ? t("account.sync.updated", { count: run.updated }) : null,
      run.removed > 0 ? t("account.sync.removed", { count: run.removed }) : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(" · ") : t("account.sync.noChanges");
  };

  const note = (run: SyncRunItem): string | null => {
    if (run.status === "failed") return errorLabel(t, run.errorCode);
    if (run.status === "skipped" && run.skipReason !== null)
      return skipReasonLabel(t, run.skipReason);
    return null;
  };

  const columns: Column<SyncRunItem>[] = [
    {
      id: "startedAt",
      header: t("account.sync.started"),
      cell: (run) => <RelativeTime at={run.startedAt} />,
      className: "whitespace-nowrap",
    },
    {
      id: "trigger",
      header: t("account.sync.triggerHeader"),
      cell: (run) => t(`account.sync.trigger.${run.trigger}`),
      hideBelow: "sm",
    },
    {
      id: "status",
      header: t("account.sync.statusHeader"),
      cell: (run) => (
        <div className="flex min-w-0 flex-col items-start gap-1">
          <StatusPill
            tone={STATUS_TONE[run.status]}
            label={t(`account.sync.status.${run.status}`)}
          />
          {note(run) ? <span className="text-xs text-muted">{note(run)}</span> : null}
        </div>
      ),
    },
    {
      id: "changes",
      header: t("account.sync.changesHeader"),
      cell: (run) => (
        <span className="text-muted">{run.status === "succeeded" ? changes(run) : "—"}</span>
      ),
      align: "end",
      hideBelow: "md",
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={runs}
      getRowKey={(run) => run.id}
      caption={t("account.sync.caption")}
      empty={
        <InlineEmpty
          icon={History}
          title={t("account.sync.emptyTitle")}
          description={t("account.sync.emptyDescription")}
        />
      }
    />
  );
}
