import type { AccountSummary, ConnectionSummary } from "@bursar/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../api";
import { feedback } from "../../components/feedback";
import { isSafeRedirect } from "../../lib/connection-state";
import { useFormatters } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";
import { invalidateAccountData } from "../../lib/use-connections";

/**
 * The only place that leaves the app for the bank. A seam so tests can spy on it: jsdom's
 * `window.location.assign` cannot be replaced.
 */
export const browser = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

export type ActionKind = "sync" | "rename" | "toggle" | "renew" | "disconnect" | "purge";

/** API codes with a translated message under `accounts.errors.codes.<code>`. */
const KNOWN_CODES = new Set([
  "sync_in_progress",
  "rate_limited",
  "connection_inactive",
  "account_inactive",
  "nothing_to_sync",
  "not_allowed",
  "connection_removed",
  "already_removed",
  "account_not_removed",
  "banking_not_configured",
  "REDIRECT_URI_NOT_ALLOWED",
  "WRONG_ASPSP_PROVIDED",
  "unknown_bank",
  "bank_error",
  "not_found",
]);

/** The item the owner acted on no longer exists or changed state: the lists are refreshed. */
export function isGone(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 409);
}

/**
 * Reports a failed action as a toast: a refusal the server explains by code is a `warning`
 * (translated, with the retry time when it has one), anything else a generic `error`.
 */
export function useReportError(): (error: unknown, action: ActionKind) => void {
  const { t } = useTranslation();
  const { relative } = useFormatters();
  const client = useQueryClient();
  return useCallback(
    (error, action) => {
      const title = t(`accounts.errors.titles.${action}`);
      if (isGone(error)) void invalidateAccountData(client);
      if (error instanceof ApiError && error.code !== null && KNOWN_CODES.has(error.code)) {
        const when = error.retryAt === null ? t("accounts.errors.later") : relative(error.retryAt);
        feedback(
          title,
          t(`accounts.errors.codes.${error.code}`, { when }),
          error.code === "bank_error" ? "error" : "warning",
        );
        return;
      }
      feedback(title, t("accounts.errors.generic"), "error");
    },
    [client, relative, t],
  );
}

/** The mutations of the Accounts page: sync, rename, disable/enable and renew. */
export function useAccountActions() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const report = useReportError();

  const syncAccount = useMutation({
    mutationFn: (account: AccountSummary) => api.syncAccount(account.id),
    onSuccess: (_result, account) => {
      feedback(
        t("accounts.toast.syncStarted"),
        t("accounts.toast.syncStartedAccount", { name: account.name }),
        "info",
      );
      // Queued syncs count as running (`syncInProgress`), so the row shows “Syncing…” at once.
      void client.invalidateQueries({ queryKey: queryKeys.connections });
    },
    onError: (error) => report(error, "sync"),
  });

  const syncConnection = useMutation({
    mutationFn: (connection: ConnectionSummary) => api.syncConnection(connection.id),
    onSuccess: (result, connection) => {
      feedback(
        t("accounts.toast.syncStarted"),
        t("accounts.toast.syncStartedConnection", {
          count: result.queued,
          bank: connection.bankName,
        }),
        "info",
      );
      void client.invalidateQueries({ queryKey: queryKeys.connections });
    },
    onError: (error) => report(error, "sync"),
  });

  const rename = useMutation({
    mutationFn: ({ account, nickname }: { account: AccountSummary; nickname: string | null }) =>
      api.updateAccount(account.id, { nickname }),
    onSuccess: (updated, { nickname }) => {
      feedback(
        t("accounts.toast.renamed"),
        nickname === null
          ? t("accounts.toast.renamedReset")
          : t("accounts.toast.renamedDetail", { name: updated.name }),
      );
      void invalidateAccountData(client);
    },
    onError: (error) => report(error, "rename"),
  });

  const setEnabled = useMutation({
    mutationFn: ({ account, enabled }: { account: AccountSummary; enabled: boolean }) =>
      api.updateAccount(account.id, { status: enabled ? "active" : "disabled" }),
    onSuccess: (updated, { enabled }) => {
      if (enabled) {
        feedback(
          t("accounts.toast.enabled"),
          t("accounts.toast.enabledDetail", { name: updated.name }),
        );
      } else {
        feedback(
          t("accounts.toast.disabled"),
          t("accounts.toast.disabledDetail", { name: updated.name }),
          "warning",
        );
      }
      void invalidateAccountData(client);
    },
    onError: (error) => report(error, "toggle"),
  });

  const renew = useMutation({
    mutationFn: (connection: ConnectionSummary) => api.renewConnection(connection.id),
    onSuccess: ({ redirectUrl }) => {
      if (isSafeRedirect(redirectUrl)) browser.assign(redirectUrl);
      else feedback(t("accounts.errors.titles.renew"), t("accounts.errors.generic"), "error");
    },
    onError: (error) => report(error, "renew"),
  });

  return { syncAccount, syncConnection, rename, setEnabled, renew };
}

export type AccountActions = ReturnType<typeof useAccountActions>;
