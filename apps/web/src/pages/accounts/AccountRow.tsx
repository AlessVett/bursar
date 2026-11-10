import type { AccountSummary, ConnectionStatus } from "@bursar/shared";
import { ExternalLink, Power, PowerOff, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { accountDetailPath } from "../../app/routes";
import { useSettingsQuery } from "../../app/useSettingsQuery";
import { CashFlowStrip } from "../../components/charts/CashFlowStrip";
import { NetChip } from "../../components/charts/NetChip";
import { DeadlineChip, MaskedIban, Money, StatusPill } from "../../components/ui";
import { accountSyncBlock } from "../../lib/connection-state";
import { useFormatters } from "../../lib/format";
import { freshnessUrgency } from "../../lib/thresholds";
import { ActionMenu, type MenuAction } from "./ActionMenu";
import type { AccountActions } from "./actions";
import { NicknameEditor } from "./NicknameEditor";

export interface AccountRowProps {
  account: AccountSummary;
  connectionStatus: ConnectionStatus;
  actions: AccountActions;
  /** Disabling asks first (level 1); the page owns the dialog. */
  onRequestDisable(account: AccountSummary): void;
}

/**
 * One account: name with inline rename, masked IBAN with copy, balance, 30-day net, freshness and
 * status chips, and the row menu. A grid: name, balance and menu share the first line below `xl`
 * (phone and tablet), the IBAN and the chips follow on their own lines; from `xl` everything is
 * one row of five columns.
 */
export function AccountRow({
  account,
  connectionStatus,
  actions,
  onRequestDisable,
}: AccountRowProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { now, relative, absolute } = useFormatters();
  const nowMs = now();
  const detailsPath = accountDetailPath(account.id);
  const block = accountSyncBlock(account, connectionStatus, nowMs);
  const fresh = freshnessUrgency(account.lastSyncedAt, nowMs);
  const disabled = account.status === "disabled";
  const highlightNegativeNet = useSettingsQuery().data?.values.highlightNegativeNet ?? true;
  const hasRecentFlow = account.daily30d.some((day) => day.count > 0);
  const masked = account.maskedIdentifier ?? (account.last4 ? `•••• ${account.last4}` : null);
  const failedSince =
    account.lastSyncError !== null &&
    (account.lastSyncedAt === null || account.lastSyncError.at > account.lastSyncedAt)
      ? account.lastSyncError.at
      : null;

  const menu: MenuAction[] = [
    {
      id: "sync",
      label: t("accounts.row.syncNow"),
      icon: RefreshCw,
      disabled: block !== null,
      disabledReason: block
        ? t(block.key, { when: block.retryAt === undefined ? "" : relative(block.retryAt) })
        : undefined,
      onSelect: () => actions.syncAccount.mutate(account),
    },
    {
      id: "toggle",
      label: disabled ? t("accounts.row.enable") : t("accounts.row.disable"),
      icon: disabled ? Power : PowerOff,
      onSelect: () =>
        disabled
          ? actions.setEnabled.mutate({ account, enabled: true })
          : onRequestDisable(account),
    },
  ];
  if (detailsPath) {
    menu.push({
      id: "details",
      label: t("accounts.row.openDetails"),
      icon: ExternalLink,
      onSelect: () => void navigate(detailsPath),
    });
  }

  return (
    <li className="relative grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-2 px-4 py-3 xl:grid-cols-[minmax(9rem,1fr)_auto_minmax(0,1.4fr)_auto_auto] xl:gap-x-4">
      <div className="min-w-0 xl:col-start-1 xl:row-start-1">
        <NicknameEditor
          name={account.name}
          nickname={account.nickname}
          placeholder={account.nickname ? (account.bankProduct ?? "") : account.name}
          to={detailsPath}
          onSave={async (nickname) => {
            await actions.rename.mutateAsync({ account, nickname });
          }}
        />
        {account.nickname && account.bankProduct ? (
          <p className="truncate text-xs text-muted">{account.bankProduct}</p>
        ) : null}
      </div>

      <div className="text-right xl:col-start-4 xl:row-start-1 xl:w-36">
        {account.balance ? (
          <Money
            minor={account.balance.amountMinor}
            currency={account.balance.currency}
            tone="auto-balance"
            className="text-base font-semibold"
          />
        ) : (
          <span className="text-sm text-muted">{t("accounts.row.balanceNone")}</span>
        )}
      </div>

      <div className="xl:col-start-5 xl:row-start-1">
        <ActionMenu label={t("accounts.row.actionsFor", { name: account.name })} actions={menu} />
      </div>

      <div className="col-span-3 min-w-0 xl:col-span-1 xl:col-start-2 xl:row-start-1">
        {masked ? (
          <MaskedIban masked={masked} iban={account.iban} copyable={account.iban !== null} />
        ) : (
          <span className="text-xs text-muted">—</span>
        )}
      </div>

      <div className="col-span-3 flex flex-wrap items-center gap-2 xl:col-span-1 xl:col-start-3 xl:row-start-1 xl:justify-end">
        <span className="inline-flex items-center gap-1" title={t("accounts.row.netTitle")}>
          <NetChip netMinor={account.net30d.netMinor} currency={account.currency} />
          <span className="text-xs text-muted">{t("accounts.row.last30d")}</span>
        </span>
        {hasRecentFlow ? (
          <div className="hidden w-24 sm:block">
            <CashFlowStrip
              variant="mini"
              buckets={account.daily30d}
              currency={account.currency}
              highlightNegativeNet={highlightNegativeNet}
              summaryLabel={t("accounts.row.miniStrip")}
            />
          </div>
        ) : null}
        {account.syncInProgress ? (
          <output className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
            {t("accounts.row.syncing")}
          </output>
        ) : disabled ? null : (
          <DeadlineChip
            urgency={fresh.urgency}
            label={
              account.lastSyncedAt === null
                ? t("accounts.freshness.never")
                : t("accounts.freshness.updated", { when: relative(account.lastSyncedAt) })
            }
            title={account.lastSyncedAt === null ? undefined : absolute(account.lastSyncedAt, true)}
          />
        )}
        {failedSince !== null ? (
          <span title={t("accounts.row.syncFailedTitle", { when: relative(failedSince) })}>
            <StatusPill tone="warning" label={t("accounts.row.syncFailed")} />
          </span>
        ) : null}
        {disabled ? (
          <span title={t("accounts.status.disabledTitle")}>
            <StatusPill tone="neutral" label={t("accounts.status.disabled")} />
          </span>
        ) : null}
        {account.status === "unavailable" ? (
          <span title={t("accounts.status.unavailableTitle")}>
            <StatusPill tone="warning" label={t("accounts.status.unavailable")} />
          </span>
        ) : null}
      </div>

      {account.syncInProgress ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-accent"
        />
      ) : null}
    </li>
  );
}
