import type { AccountDetailResponse } from "@bursar/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../api";
import { feedback } from "../../components/feedback";
import { useFormatters } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import type { AccountRunAction } from "./account-state";

export interface AccountActions {
  run(action: AccountRunAction): void;
  pending: Record<AccountRunAction, boolean>;
}

/**
 * The three things the detail page can do to an account: sync it now, renew its consent (leaves the
 * app for the bank) and enable it again. Feedback goes through `feedback()`; sync refusals from the
 * API become warnings with a sentence that names the account and the bank, never an id.
 */
export function useAccountActions(detail: AccountDetailResponse): AccountActions {
  const { t } = useTranslation();
  const { relative } = useFormatters();
  const queryClient = useQueryClient();
  const accountId = detail.account.id;
  const accountName = detail.account.name;
  const bank = detail.connection.bankName;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.account(accountId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.connections }),
      queryClient.invalidateQueries({ queryKey: queryKeys.summary }),
    ]);
  };

  const sync = useMutation({
    mutationFn: () => api.syncAccount(accountId),
    onSuccess: async () => {
      feedback(
        t("account.toast.syncStarted"),
        t("account.toast.syncStartedDetail", { account: accountName }),
        "info",
      );
      await refresh();
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : null;
      if (code === "sync_in_progress") {
        feedback(
          t("account.toast.alreadySyncing"),
          t("account.toast.alreadySyncingDetail", { account: accountName }),
          "warning",
        );
      } else if (code === "rate_limited") {
        const retryAt = error instanceof ApiError ? error.retryAt : null;
        feedback(
          t("account.toast.paused"),
          retryAt === null
            ? t("account.toast.pausedNoTime", { bank })
            : t("account.toast.pausedDetail", { bank, when: relative(retryAt) }),
          "warning",
        );
      } else if (code === "connection_inactive") {
        feedback(
          t("account.toast.needsRenewal"),
          t("account.toast.needsRenewalDetail", { bank, account: accountName }),
          "warning",
        );
      } else if (code === "account_inactive" || code === "nothing_to_sync") {
        feedback(
          t("account.toast.notSynced"),
          t("account.toast.notSyncedDetail", { account: accountName }),
          "warning",
        );
      } else {
        feedback(t("account.toast.failed"), t("account.toast.failedDetail"), "error");
      }
    },
  });

  const renew = useMutation({
    mutationFn: () => api.renewConnection(detail.connection.id),
    onSuccess: ({ redirectUrl }) => {
      window.location.assign(redirectUrl);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "banking_not_configured") {
        feedback(t("account.toast.bankingOff"), t("account.toast.bankingOffDetail"), "warning");
      } else {
        feedback(t("account.toast.failed"), t("account.toast.failedDetail"), "error");
      }
    },
  });

  const enable = useMutation({
    mutationFn: () => api.updateAccount(accountId, { status: "active" }),
    onSuccess: async () => {
      feedback(
        t("account.toast.enabled"),
        t("account.toast.enabledDetail", { account: accountName }),
      );
      await refresh();
    },
    onError: () => {
      feedback(t("account.toast.failed"), t("account.toast.failedDetail"), "error");
    },
  });

  return {
    run(action) {
      if (action === "sync") sync.mutate();
      else if (action === "renew") renew.mutate();
      else enable.mutate();
    },
    pending: { sync: sync.isPending, renew: renew.isPending, enable: enable.isPending },
  };
}
