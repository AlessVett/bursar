import type { CashFlowResponse, HomeSummary } from "@bursar/shared";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RouteId } from "../../app/routes";
import { ShippedLink } from "../../app/ShippedLink";
import { Money } from "../../components/ui";
import { amountTone } from "../../lib/tones";

export interface KpiRowProps {
  balances: HomeSummary["balances"];
  /** The 30-day cash flow of the currency on screen; null hides the flow figures. */
  cashflow: CashFlowResponse | null;
  /** Added to the Transactions links when several currencies exist. */
  currencyParam: string | null;
  highlightNegativeNet: boolean;
}

function KpiTile({
  route,
  search,
  label,
  hint,
  className = "",
  children,
}: {
  route: RouteId;
  search?: Record<string, string>;
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  const base = `flex flex-col rounded-2xl border border-subtle bg-surface p-3 sm:p-4 ${className}`;
  return (
    <ShippedLink
      route={route}
      search={search}
      className={`${base} transition-colors hover:border-primary/40 hover:bg-surface-2`}
      plainClassName={base}
    >
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="mt-2 font-display text-base font-semibold tabular sm:text-xl lg:text-2xl">
        {children}
      </span>
      {hint ? <span className="mt-1 text-xs text-muted">{hint}</span> : null}
    </ShippedLink>
  );
}

/** Balance per currency and the 30-day in, out and net; each tile opens the filtered list. */
export function KpiRow({ balances, cashflow, currencyParam, highlightNegativeNet }: KpiRowProps) {
  const { t } = useTranslation();
  const accountCount = balances.reduce((total, balance) => total + balance.accountCount, 0);
  const withCurrency = (search: Record<string, string>): Record<string, string> =>
    currencyParam ? { ...search, currency: currencyParam } : search;
  const totals = cashflow?.totals ?? null;
  const outflow = totals ? Math.abs(totals.outMinor) : 0;
  return (
    <section aria-label={t("home.kpi.label")} className="grid grid-cols-3 gap-3 lg:grid-cols-4">
      <KpiTile
        route="accounts"
        label={t("home.kpi.balance")}
        hint={t("home.kpi.accounts", { count: accountCount })}
        className="col-span-3 lg:col-span-1"
      >
        {balances.length === 0 ? (
          <span className="text-sm font-medium text-muted">{t("home.kpi.noBalance")}</span>
        ) : (
          balances.map((balance) => (
            <span key={balance.currency} className="block">
              <Money minor={balance.amountMinor} currency={balance.currency} tone="auto-balance" />
            </span>
          ))
        )}
      </KpiTile>
      {cashflow && totals ? (
        <>
          <KpiTile
            route="transactions"
            search={withCurrency({ tab: "in" })}
            label={t("home.kpi.in")}
          >
            <Money minor={Math.abs(totals.inMinor)} currency={cashflow.currency} tone="auto-flow" />
          </KpiTile>
          <KpiTile
            route="transactions"
            search={withCurrency({ tab: "out" })}
            label={t("home.kpi.out")}
          >
            <Money
              minor={outflow}
              currency={cashflow.currency}
              tone={outflow === 0 ? "muted" : "ink"}
            />
          </KpiTile>
          <KpiTile
            route="transactions"
            search={currencyParam ? withCurrency({}) : undefined}
            label={t("home.kpi.net")}
            hint={t("home.kpi.transactions", { count: totals.count })}
          >
            <Money
              minor={totals.netMinor}
              currency={cashflow.currency}
              sign="always"
              tone={amountTone(totals.netMinor, "net", { highlightNegativeNet })}
            />
          </KpiTile>
        </>
      ) : null}
    </section>
  );
}
