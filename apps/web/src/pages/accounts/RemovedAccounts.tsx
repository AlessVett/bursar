import type { RemovedAccountSummary } from "@bursar/shared";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Cascade } from "../../components/ui";
import { formatCount } from "../../lib/connection-state";
import { useFormatters } from "../../lib/format";

/**
 * Accounts of disconnected banks. Their transactions stay in Bursar until purged (spec §6.3);
 * the purge is its own level-3 action, opened by the page.
 */
export function RemovedAccounts({
  accounts,
  index,
  onRequestPurge,
}: {
  accounts: RemovedAccountSummary[];
  index: number;
  onRequestPurge(account: RemovedAccountSummary): void;
}) {
  const { t } = useTranslation();
  const { locale, relative, absolute } = useFormatters();
  const headingId = useId();
  return (
    <Cascade index={index}>
      <section aria-labelledby={headingId}>
        <Card padding="none">
          <div className="px-4 py-3">
            <h2 id={headingId} className="font-display text-base font-bold text-fg">
              {t("accounts.removed.title")}
            </h2>
            <p className="text-sm text-muted">{t("accounts.removed.description")}</p>
          </div>
          <ul className="divide-y divide-subtle border-t border-subtle">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-fg">{account.name}</p>
                  <p className="truncate text-xs text-muted">
                    {account.bankName}
                    {account.maskedIdentifier ? (
                      <>
                        {" · "}
                        <span className="font-mono">{account.maskedIdentifier}</span>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
                  <span className="tabular text-sm text-fg">
                    {t("accounts.removed.transactions", {
                      count: account.transactionCount,
                      n: formatCount(locale, account.transactionCount),
                    })}
                  </span>
                  <span className="text-xs text-muted" title={absolute(account.removedAt, true)}>
                    {t("accounts.removed.since", { when: relative(account.removedAt) })}
                  </span>
                  <Button variant="danger" size="sm" onClick={() => onRequestPurge(account)}>
                    {account.transactionCount > 0
                      ? t("accounts.removed.purge")
                      : t("accounts.removed.remove")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </Cascade>
  );
}
