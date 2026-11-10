import type { RemovedAccountSummary } from "@bursar/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { feedback } from "../../components/feedback";
import { ConfirmDialog } from "../../components/ui";
import { formatCount } from "../../lib/connection-state";
import { useFormatters } from "../../lib/format";
import { invalidateAccountData } from "../../lib/use-connections";
import { isGone, useReportError } from "./actions";

/**
 * Purge is a separate level-3 action (spec §6.3): the count is the one on the list, the button
 * repeats the verb with it (“Yes, purge 1,234 transactions”). An account with no transactions
 * left is simply removed.
 */
export function PurgeDialog({
  account,
  onClose,
}: {
  account: RemovedAccountSummary | null;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { locale } = useFormatters();
  const report = useReportError();

  const purge = useMutation({
    mutationFn: (target: RemovedAccountSummary) => api.purgeAccount(target.id),
    onSuccess: (result, target) => {
      if (result.transactions === 0) {
        feedback(
          t("accounts.toast.removedAccount"),
          t("accounts.toast.removedAccountDetail", { name: target.name }),
        );
      } else {
        feedback(
          t("accounts.toast.purged"),
          t("accounts.toast.purgedDetail", {
            count: result.transactions,
            n: formatCount(locale, result.transactions),
            name: target.name,
          }),
        );
      }
      void invalidateAccountData(client);
    },
    onError: (error) => report(error, "purge"),
  });

  async function confirm(): Promise<void> {
    if (!account) return;
    try {
      await purge.mutateAsync(account);
    } catch (error) {
      // A refusal the server explains (already purged, not removed) closes the dialog; the
      // lists were refreshed. Anything else keeps it open for another try.
      if (!isGone(error)) throw error;
    }
  }

  const count = account?.transactionCount ?? 0;
  const n = formatCount(locale, count);
  const name = account?.name ?? "";
  return (
    <ConfirmDialog
      open={account !== null}
      tone="danger"
      title={
        count > 0 ? t("accounts.purge.title", { name }) : t("accounts.purge.titleEmpty", { name })
      }
      body={
        count > 0 ? t("accounts.purge.body", { count, n }) : t("accounts.purge.bodyEmpty", { name })
      }
      confirmLabel={
        count > 0 ? t("accounts.purge.confirm", { count, n }) : t("accounts.purge.confirmEmpty")
      }
      busy={purge.isPending}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}
