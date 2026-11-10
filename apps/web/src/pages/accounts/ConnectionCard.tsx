import type { AccountSummary, ConnectionSummary } from "@bursar/shared";
import { KeyRound, RefreshCw, Unplug } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Cascade, DeadlineChip, InlineEmpty, StatusPill } from "../../components/ui";
import {
  type ConnectionAction,
  connectionActions,
  connectionTone,
} from "../../lib/connection-state";
import { useFormatters } from "../../lib/format";
import { consentUrgency, type Urgency } from "../../lib/thresholds";
import { AccountRow } from "./AccountRow";
import { ActionMenu, type MenuAction } from "./ActionMenu";
import type { AccountActions } from "./actions";
import { BankLogo } from "./BankLogo";

export interface ConnectionCardProps {
  connection: ConnectionSummary;
  /** Position in the sorted list, for the entry cascade. */
  index: number;
  actions: AccountActions;
  onRequestDisconnect(connection: ConnectionSummary): void;
  onRequestDisable(account: AccountSummary): void;
}

function regionName(country: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(country) ?? country;
  } catch {
    return country;
  }
}

const HINT_CLASSES = {
  expiring: "bg-warning-soft text-warning",
  expired: "bg-danger-soft text-danger",
  revoked: "bg-danger-soft text-danger",
  error: "bg-danger-soft text-danger",
} as const;

/**
 * One bank connection: logo (or initials), name, status pill, consent chip, the primary action of
 * its state machine and a “…” menu with the others (the destructive one last, in red), then its
 * accounts. Below `md` the chips and the primary button take their own lines.
 */
export function ConnectionCard({
  connection,
  index,
  actions,
  onRequestDisconnect,
  onRequestDisable,
}: ConnectionCardProps) {
  const { t } = useTranslation();
  const { now, locale, timeZone, absolute } = useFormatters();
  const headingId = useId();
  const nowMs = now();
  const status = connection.status;
  const plan = connectionActions(status);
  const syncable = connection.accounts.filter((account) => account.status === "active").length;
  const noneToSync = syncable === 0;
  const renewing = actions.renew.isPending && actions.renew.variables?.id === connection.id;
  const syncing =
    actions.syncConnection.isPending && actions.syncConnection.variables?.id === connection.id;

  function consentChip(): { urgency: Urgency; label: string } | null {
    if (status === "revoked" || status === "error") return null;
    const consent = consentUrgency(connection.validUntil, nowMs, timeZone);
    if (status === "expired" || consent.expired) {
      if (!consent.expired) return { urgency: "danger", label: t("connection.consent.ended") };
      return {
        urgency: "danger",
        label:
          consent.daysLeft < 0
            ? t("connection.consent.expiredAgo", { count: -consent.daysLeft })
            : t("connection.consent.expiredToday"),
      };
    }
    return {
      urgency: consent.urgency,
      label:
        consent.daysLeft <= 0
          ? t("connection.consent.expiresToday")
          : t("connection.consent.expiresIn", { count: consent.daysLeft }),
    };
  }
  const chip = consentChip();

  function describe(action: ConnectionAction): MenuAction {
    if (action === "renew") {
      return {
        id: "renew",
        label: t("connection.actions.renew"),
        icon: KeyRound,
        onSelect: () => actions.renew.mutate(connection),
      };
    }
    if (action === "sync") {
      const blockedKey = plan.blocked.sync;
      const reason = blockedKey
        ? t(blockedKey)
        : noneToSync
          ? t("connection.blocked.noActiveAccounts")
          : undefined;
      return {
        id: "sync",
        label: t("connection.actions.sync", { count: syncable }),
        icon: RefreshCw,
        disabled: reason !== undefined,
        disabledReason: reason,
        onSelect: () => actions.syncConnection.mutate(connection),
      };
    }
    return {
      id: "disconnect",
      label: t("connection.actions.disconnect"),
      icon: Unplug,
      tone: "danger",
      onSelect: () => onRequestDisconnect(connection),
    };
  }

  const menu: MenuAction[] = [];
  for (const action of plan.allowed) {
    if (action !== plan.primary && action !== "disconnect") menu.push(describe(action));
  }
  for (const action of Object.keys(plan.blocked) as ConnectionAction[]) menu.push(describe(action));
  menu.push({ ...describe("disconnect"), separatorBefore: menu.length > 0 });

  const syncReason = plan.blocked.sync
    ? t(plan.blocked.sync)
    : noneToSync
      ? t("connection.blocked.noActiveAccounts")
      : undefined;

  return (
    <Cascade index={index}>
      <section aria-labelledby={headingId}>
        <Card padding="none">
          <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 px-4 py-3 md:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] md:gap-x-4">
            <BankLogo
              name={connection.bankName}
              country={connection.country}
              hasLogo={connection.hasLogo}
            />
            <div className="min-w-0">
              <h2 id={headingId} className="truncate font-display text-base font-bold text-fg">
                {connection.bankName}
              </h2>
              <p className="truncate text-xs text-muted">
                {t("connection.meta", {
                  country: regionName(connection.country, locale),
                  date: absolute(connection.createdAt),
                })}
              </p>
            </div>
            <div className="md:col-start-5 md:row-start-1">
              <ActionMenu
                label={t("connection.actions.menu", { bank: connection.bankName })}
                actions={menu}
              />
            </div>
            <div className="col-span-3 flex flex-wrap items-center gap-2 md:col-span-1 md:col-start-3 md:row-start-1">
              <StatusPill tone={connectionTone(status)} label={t(`connection.status.${status}`)} />
              {chip ? (
                <DeadlineChip
                  urgency={chip.urgency}
                  label={chip.label}
                  title={t("connection.consent.validUntil", {
                    date: absolute(connection.validUntil, true),
                  })}
                />
              ) : null}
            </div>
            {plan.primary === "renew" ? (
              <Button
                data-qa-skip
                className="col-span-3 w-full md:col-span-1 md:col-start-4 md:row-start-1 md:w-auto"
                icon={KeyRound}
                loading={renewing}
                onClick={() => actions.renew.mutate(connection)}
              >
                {t("connection.actions.renew")}
              </Button>
            ) : null}
            {plan.primary === "sync" ? (
              <Button
                variant="secondary"
                className="col-span-3 w-full md:col-span-1 md:col-start-4 md:row-start-1 md:w-auto"
                icon={RefreshCw}
                loading={syncing}
                disabled={noneToSync}
                title={syncReason}
                onClick={() => actions.syncConnection.mutate(connection)}
              >
                {t("connection.actions.sync", { count: syncable })}
              </Button>
            ) : null}
          </header>

          {status !== "active" ? (
            <p className={`mx-4 mb-3 rounded-xl px-3 py-2 text-sm ${HINT_CLASSES[status]}`}>
              {t(`connection.hint.${status}`)}
            </p>
          ) : null}

          {connection.accounts.length === 0 ? (
            <div className="border-t border-subtle">
              <InlineEmpty
                title={t("accounts.noAccounts.title")}
                description={t("accounts.noAccounts.body")}
              />
            </div>
          ) : (
            <ul className="divide-y divide-subtle border-t border-subtle">
              {connection.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  connectionStatus={status}
                  actions={actions}
                  onRequestDisable={onRequestDisable}
                />
              ))}
            </ul>
          )}
        </Card>
      </section>
    </Cascade>
  );
}
