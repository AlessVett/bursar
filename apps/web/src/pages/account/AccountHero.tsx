import type { AccountDetailResponse } from "@bursar/shared";
import { Check, RefreshCw, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, DeadlineChip, MaskedIban, Money, StatusPill } from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { freshnessUrgency } from "../../lib/thresholds";
import { useAccountActions as useAccountsPageActions } from "../accounts/actions";
import { NicknameEditor } from "../accounts/NicknameEditor";
import { accountActionStates, type StripeTone, statusPill, stripeTone } from "./account-state";
import { useAccountActions } from "./useAccountActions";

const STRIPE_CLASS: Record<StripeTone, string> = {
  positive: "bg-positive",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-muted",
};

const ACTION_ICON = { sync: RefreshCw, renew: RotateCw, enable: Check } as const;

/**
 * The identity card of the account: a 6 px stripe in the state colour, the name (renamed in place),
 * bank, masked IBAN with copy, one status pill, freshness, the balance and the primary action.
 */
export function AccountHero({ detail }: { detail: AccountDetailResponse }) {
  const { t } = useTranslation();
  const { relative, absolute, now } = useFormatters();
  const actions = useAccountActions(detail);
  // Task 18's rename mutation: saves, shows the "Account renamed" toast, reports a failure and
  // invalidates connections, summary and the `["accounts"]` prefix (this page's detail query).
  const { rename } = useAccountsPageActions();
  const { account, connection } = detail;

  const tone = stripeTone(detail);
  const pill = statusPill(detail);
  const freshness = freshnessUrgency(account.lastSyncedAt, now());
  const primary = accountActionStates(detail, now()).find((state) => state.primary);
  const primaryAction = primary && primary.action !== "disconnect" ? primary.action : null;
  const bankLine = [connection.bankName, account.nickname !== null ? account.bankProduct : null]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");

  return (
    <section
      aria-label={t("account.hero.label")}
      className="overflow-hidden rounded-2xl border border-subtle bg-surface shadow-sm"
    >
      <div
        aria-hidden="true"
        data-testid="status-stripe"
        data-tone={tone}
        className={`h-1.5 ${STRIPE_CLASS[tone]}`}
      />
      <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:p-6">
        <div className="min-w-0 space-y-3">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-semibold text-fg">
              <NicknameEditor
                name={account.name}
                nickname={account.nickname}
                placeholder={account.nickname ? (account.bankProduct ?? "") : account.name}
                onSave={async (nickname) => {
                  await rename.mutateAsync({ account, nickname });
                }}
              />
            </h1>
            <p className="mt-1 text-sm text-muted">{bankLine}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={pill.tone} label={t(`account.status.${pill.key}`)} />
            {account.syncInProgress ? (
              <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted">
                <RefreshCw
                  aria-hidden
                  size={14}
                  className="animate-spin motion-reduce:animate-none"
                />
                {t("account.hero.syncing")}
              </span>
            ) : (
              <DeadlineChip
                urgency={freshness.urgency}
                label={
                  account.lastSyncedAt === null
                    ? t("account.hero.neverUpdated")
                    : t("account.hero.updated", { when: relative(account.lastSyncedAt) })
                }
                title={
                  account.lastSyncedAt === null ? undefined : absolute(account.lastSyncedAt, true)
                }
              />
            )}
            <span className="text-xs font-medium text-muted">{account.currency}</span>
          </div>
          {account.maskedIdentifier !== null ? (
            <MaskedIban masked={account.maskedIdentifier} iban={account.iban} copyable />
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-3 md:items-end md:text-right">
          {account.balance !== null ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                {t("account.hero.balance")}
              </p>
              <Money
                minor={account.balance.amountMinor}
                currency={account.balance.currency}
                tone="auto-balance"
                className="font-display text-3xl font-semibold"
              />
              <p className="text-xs text-muted">
                {t("account.hero.balanceAsOf", { when: relative(account.balance.asOf) })}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">{t("account.hero.noBalance")}</p>
          )}
          {primary && primaryAction ? (
            <Button
              variant="primary"
              icon={ACTION_ICON[primaryAction]}
              loading={actions.pending[primaryAction]}
              disabled={primary.blockedKey !== null}
              title={primary.blockedKey !== null ? t(primary.blockedKey) : undefined}
              data-qa-skip={primaryAction === "renew" ? "" : undefined}
              onClick={() => actions.run(primaryAction)}
            >
              {t(`account.actions.${primaryAction}`)}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
