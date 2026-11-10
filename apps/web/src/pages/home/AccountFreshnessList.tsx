import type { AccountStatus, AccountSummary } from "@bursar/shared";
import { useTranslation } from "react-i18next";
import { ShippedLink } from "../../app/ShippedLink";
import { NetChip } from "../../components/charts/NetChip";
import { DeadlineChip, InlineEmpty, MaskedIban, Money, StatusPill } from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { freshnessUrgency } from "../../lib/thresholds";

const STATUS_TONE: Record<AccountStatus, "positive" | "warning" | "neutral"> = {
  active: "positive",
  unavailable: "warning",
  disabled: "neutral",
  removed: "neutral",
};

const ROW = "flex min-h-14 items-center gap-3 rounded-xl px-2 py-3 sm:px-3";

/** Accounts on Home: name, masked identifier, freshness chip, balance and 30-day net. */
export function AccountFreshnessList({
  accounts,
  highlightNegativeNet,
}: {
  accounts: readonly AccountSummary[];
  highlightNegativeNet: boolean;
}) {
  const { t } = useTranslation();
  const { relative, absolute, now } = useFormatters();
  const current = now();
  return (
    <section
      aria-labelledby="home-accounts"
      className="rounded-2xl border border-subtle bg-surface p-4 sm:p-6"
    >
      <div className="flex items-baseline gap-2">
        <h2 id="home-accounts" className="font-display text-base font-semibold text-fg">
          {t("home.accounts.title")}
        </h2>
        <span className="text-sm text-muted tabular">{accounts.length}</span>
      </div>
      {accounts.length === 0 ? (
        <div className="mt-4">
          <InlineEmpty title={t("home.accounts.empty")} />
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-subtle">
          {accounts.map((account) => {
            const freshness = freshnessUrgency(account.lastSyncedAt, current);
            const label =
              account.lastSyncedAt === null
                ? t("freshness.never")
                : t("freshness.updated", { when: relative(account.lastSyncedAt) });
            return (
              <li key={account.id}>
                <ShippedLink
                  route="account"
                  params={{ accountId: account.id }}
                  className={`${ROW} transition-colors hover:bg-surface-2`}
                  plainClassName={ROW}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-fg">{account.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {account.maskedIdentifier ? (
                        <MaskedIban masked={account.maskedIdentifier} />
                      ) : null}
                      {account.syncInProgress ? (
                        <StatusPill tone="info" label={t("freshness.syncing")} />
                      ) : (
                        <DeadlineChip
                          urgency={freshness.urgency}
                          label={label}
                          title={
                            account.lastSyncedAt === null
                              ? undefined
                              : absolute(account.lastSyncedAt, true)
                          }
                        />
                      )}
                      {account.status === "active" ? null : (
                        <StatusPill
                          tone={STATUS_TONE[account.status]}
                          label={t(`status.account.${account.status}`)}
                        />
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 text-sm font-semibold">
                    {account.balance ? (
                      <Money
                        minor={account.balance.amountMinor}
                        currency={account.balance.currency}
                        tone="auto-balance"
                      />
                    ) : (
                      <span className="text-xs font-normal text-muted">
                        {t("home.accounts.noBalance")}
                      </span>
                    )}
                    <NetChip
                      netMinor={account.net30d.netMinor}
                      currency={account.currency}
                      highlightNegativeNet={highlightNegativeNet}
                    />
                  </div>
                </ShippedLink>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
