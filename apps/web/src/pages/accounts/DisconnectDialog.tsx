import type { ConnectionSummary } from "@bursar/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { feedback } from "../../components/feedback";
import { Button, Dialog } from "../../components/ui";
import { formatCount } from "../../lib/connection-state";
import { useFormatters } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import { invalidateAccountData } from "../../lib/use-connections";
import { isGone, useReportError } from "./actions";

/** The dialog reads only these two fields, so the Account detail page can pass a partial object. */
export type DisconnectTarget = Pick<ConnectionSummary, "id" | "bankName">;

/**
 * Level-3 confirmation (UX doc §7): a question as the title, what goes away with the real counts
 * from `removal-preview`, and a button that repeats the verb. The button stays disabled until
 * the counts have loaded; Cancel never is.
 */
export function DisconnectDialog({
  connection,
  onClose,
}: {
  connection: DisconnectTarget | null;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { locale } = useFormatters();
  const report = useReportError();
  const connectionId = connection?.id ?? 0;

  const preview = useQuery({
    queryKey: [...queryKeys.connections, connectionId, "removal-preview"],
    queryFn: () => api.removalPreview(connectionId),
    enabled: connection !== null,
    gcTime: 0,
  });

  const disconnect = useMutation({
    mutationFn: (target: DisconnectTarget) => api.disconnect(target.id),
    onSuccess: (result, target) => {
      feedback(
        t("accounts.toast.disconnected"),
        t("accounts.toast.disconnectedDetail", {
          bank: target.bankName,
          count: result.removedAccounts,
        }),
      );
      void invalidateAccountData(client);
    },
    onError: (error) => report(error, "disconnect"),
  });

  async function confirm(): Promise<void> {
    if (!connection) return;
    try {
      await disconnect.mutateAsync(connection);
      onClose();
    } catch (error) {
      if (isGone(error)) onClose();
    }
  }

  const counts = preview.data;
  return (
    <Dialog
      open={connection !== null}
      onClose={onClose}
      title={t("accounts.disconnect.title", { bank: connection?.bankName ?? "" })}
      footer={
        <>
          <Button variant="secondary" disabled={disconnect.isPending} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={disconnect.isPending}
            disabled={!preview.isSuccess}
            onClick={() => void confirm()}
          >
            {t("accounts.disconnect.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-fg">
        <p>{t("accounts.disconnect.lead")}</p>
        {counts ? (
          <ul className="list-disc space-y-1 pl-5">
            <li>{t("accounts.disconnect.accounts", { count: counts.accounts })}</li>
            <li>
              {counts.transactions > 0
                ? t("accounts.disconnect.transactions", {
                    count: counts.transactions,
                    n: formatCount(locale, counts.transactions),
                  })
                : t("accounts.disconnect.noTransactions")}
            </li>
          </ul>
        ) : preview.isError ? (
          <p role="alert" className="text-danger">
            {t("accounts.disconnect.failed")}{" "}
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => void preview.refetch()}
            >
              {t("accounts.disconnect.retry")}
            </button>
          </p>
        ) : (
          <p className="text-muted">{t("accounts.disconnect.loading")}</p>
        )}
        <p className="text-muted">{t("accounts.disconnect.outro")}</p>
      </div>
    </Dialog>
  );
}
