import {
  type CashFlowBucket,
  type CashFlowResponse,
  type HomeSummary,
  localDateSchema,
} from "@bursar/shared";
import { useQuery } from "@tanstack/react-query";
import { Landmark, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { ShippedLink } from "../app/ShippedLink";
import { useSettingsQuery } from "../app/useSettingsQuery";
import { CashFlowStrip } from "../components/charts/CashFlowStrip";
import { dayMonthLabel } from "../components/charts/chart-colors";
import { Button, Cascade, EmptyState, InlineEmpty, Money } from "../components/ui";
import { useFormatters } from "../lib/format";
import { queryKeys } from "../lib/query-keys";
import { amountTone } from "../lib/tones";
import { useUrlState } from "../lib/url-state";
import { ConnectBankButton } from "./connect/ConnectBankButton";
import { AccountFreshnessList } from "./home/AccountFreshnessList";
import { AlertList } from "./home/AlertList";
import { Greeting } from "./home/Greeting";
import { KpiRow } from "./home/KpiRow";

function HomeSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">{t("home.loading")}</span>
      <div className="grid grid-cols-3 gap-3 lg:grid-cols-4">
        <div className="col-span-3 h-24 animate-pulse rounded-2xl bg-surface-2 lg:col-span-1" />
        <div className="h-24 animate-pulse rounded-2xl bg-surface-2" />
        <div className="h-24 animate-pulse rounded-2xl bg-surface-2" />
        <div className="h-24 animate-pulse rounded-2xl bg-surface-2" />
      </div>
      <div className="h-72 animate-pulse rounded-2xl bg-surface-2" />
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="h-56 animate-pulse rounded-2xl bg-surface-2 lg:col-span-3" />
        <div className="h-56 animate-pulse rounded-2xl bg-surface-2 lg:col-span-2" />
      </div>
    </div>
  );
}

function CurrencySwitch({
  currencies,
  value,
  onChange,
}: {
  currencies: readonly string[];
  value: string;
  onChange: (currency: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="inline-flex rounded-xl border border-subtle bg-surface-2 p-0.5">
      <legend className="sr-only">{t("home.cashflow.currency")}</legend>
      {currencies.map((currency) => (
        <button
          key={currency}
          type="button"
          aria-pressed={currency === value}
          onClick={() => onChange(currency)}
          className={`min-h-11 rounded-lg px-3 text-xs font-semibold tabular transition-colors sm:min-h-8 ${
            currency === value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
          }`}
        >
          {currency}
        </button>
      ))}
    </fieldset>
  );
}

function StripLegend() {
  const { t } = useTranslation();
  return (
    <ul aria-hidden="true" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-positive" />
        {t("cashflow.in")}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-ink" />
        {t("cashflow.out")}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-0.5 w-3 rounded-full bg-primary" />
        {t("cashflow.balance")}
      </li>
    </ul>
  );
}

function SelectionFooter({
  bucket,
  currency,
  currencyParam,
  highlightNegativeNet,
  onClear,
}: {
  bucket: CashFlowBucket | null;
  currency: string;
  currencyParam: string | null;
  highlightNegativeNet: boolean;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { locale } = useFormatters();
  if (!bucket) return <p className="mt-3 text-xs text-muted">{t("home.cashflow.hint")}</p>;
  const date = dayMonthLabel(bucket.date, locale);
  const search: Record<string, string> = { from: bucket.date, to: bucket.end };
  if (currencyParam) search.currency = currencyParam;
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-xl bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-fg">
          {date}
          <span className="ml-2 font-normal text-muted">
            {t("cashflow.count", { count: bucket.count })}
          </span>
        </p>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-muted">{t("cashflow.in")}</dt>
            <dd>
              <Money minor={Math.abs(bucket.inMinor)} currency={currency} tone="auto-flow" />
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted">{t("cashflow.out")}</dt>
            <dd>
              <Money
                minor={Math.abs(bucket.outMinor)}
                currency={currency}
                tone={bucket.outMinor === 0 ? "muted" : "ink"}
              />
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted">{t("cashflow.net")}</dt>
            <dd>
              <Money
                minor={bucket.netMinor}
                currency={currency}
                sign="always"
                tone={amountTone(bucket.netMinor, "net", { highlightNegativeNet })}
              />
            </dd>
          </div>
        </dl>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {bucket.count === 0 ? (
          <span className="text-sm text-muted">{t("home.cashflow.none", { date })}</span>
        ) : (
          <ShippedLink
            route="transactions"
            search={search}
            whenUnshipped="hide"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("home.cashflow.see", { count: bucket.count, date })}
          </ShippedLink>
        )}
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t("home.cashflow.clear")}
        </Button>
      </div>
    </div>
  );
}

function HomeContent({
  summary,
  highlightNegativeNet,
}: {
  summary: HomeSummary;
  highlightNegativeNet: boolean;
}) {
  const { t } = useTranslation();
  const base = summary.cashflow30d;
  const currencies = base?.currencies ?? [];
  const [url, setUrl] = useUrlState(
    { currency: "", day: "" },
    {
      validate: {
        currency: (value) => currencies.includes(value),
        day: (value) => localDateSchema.safeParse(value).success,
      },
      resetOnChange: ["day"],
    },
  );
  const currency = url.currency || base?.currency || "";
  const isDefault = base !== null && currency === base.currency;
  const other = useQuery({
    queryKey: queryKeys.cashflow({ currency, from: base?.from ?? "", to: base?.to ?? "" }),
    queryFn: () => api.cashflow({ currency, from: base?.from, to: base?.to }),
    enabled: base !== null && currency !== "" && !isDefault,
  });
  const cashflow: CashFlowResponse | null = isDefault ? base : (other.data ?? null);
  // A 204 (no transactions in this currency for the window) is a success with null data:
  // show an empty state and zeroed figures, not the loading skeleton.
  const emptyOther = !isDefault && other.isSuccess && other.data === null;
  const kpiCashflow: CashFlowResponse | null =
    cashflow ??
    (emptyOther && base
      ? {
          ...base,
          currency,
          buckets: [],
          totals: { inMinor: 0, outMinor: 0, netMinor: 0, count: 0 },
        }
      : null);
  const mixed = currencies.length > 1;
  // No transaction in the other currency: its links would open a list filtered to nothing.
  const currencyParam = mixed && kpiCashflow && !emptyOther ? kpiCashflow.currency : null;
  const selected = cashflow?.buckets.find((bucket) => bucket.date === url.day) ?? null;

  return (
    <>
      <Cascade index={1}>
        <div className="flex flex-col gap-2">
          <KpiRow
            balances={summary.balances}
            cashflow={kpiCashflow}
            currencyParam={currencyParam}
            highlightNegativeNet={highlightNegativeNet}
          />
          {summary.balances.length > 1 ? (
            <p className="text-xs text-muted">{t("home.kpi.mixedCurrencies")}</p>
          ) : null}
        </div>
      </Cascade>
      {base ? (
        <Cascade index={2}>
          <section
            aria-labelledby="home-cashflow"
            className="rounded-2xl border border-subtle bg-surface p-4 sm:p-6"
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 id="home-cashflow" className="font-display text-base font-semibold text-fg">
                {t("home.cashflow.title")}
              </h2>
              {mixed ? (
                <CurrencySwitch
                  currencies={currencies}
                  value={currency}
                  onChange={(next) => setUrl({ currency: next === base.currency ? "" : next })}
                />
              ) : null}
            </div>
            {cashflow ? (
              <>
                <CashFlowStrip
                  buckets={cashflow.buckets}
                  currency={cashflow.currency}
                  variant="full"
                  showBalance
                  highlightNegativeNet={highlightNegativeNet}
                  selectedDate={selected?.date ?? null}
                  onSelectBucket={(bucket) =>
                    setUrl({ day: bucket.date === url.day ? "" : bucket.date })
                  }
                  summaryLabel={t("home.cashflow.title")}
                />
                <StripLegend />
                <SelectionFooter
                  bucket={selected}
                  currency={cashflow.currency}
                  currencyParam={currencyParam}
                  highlightNegativeNet={highlightNegativeNet}
                  onClear={() => setUrl({ day: "" })}
                />
              </>
            ) : emptyOther ? (
              <InlineEmpty title={t("home.cashflow.empty", { currency })} />
            ) : other.isError ? (
              <div className="flex flex-col items-start gap-3">
                <InlineEmpty icon={TriangleAlert} title={t("home.cashflow.error", { currency })} />
                <Button variant="secondary" size="sm" onClick={() => void other.refetch()}>
                  {t("home.cashflow.retry")}
                </Button>
              </div>
            ) : (
              <div aria-busy="true" className="h-56 animate-pulse rounded-xl bg-surface-2">
                <span className="sr-only">{t("home.cashflow.loading")}</span>
              </div>
            )}
          </section>
        </Cascade>
      ) : null}
      <Cascade index={3}>
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <AccountFreshnessList
              accounts={summary.accounts}
              highlightNegativeNet={highlightNegativeNet}
            />
          </div>
          <div className="lg:col-span-2">
            <AlertList alerts={summary.alerts} />
          </div>
        </div>
      </Cascade>
    </>
  );
}

/** Role home (UX doc §4): greeting, key figures, 30-day cash-flow strip, accounts, alerts. */
export function HomePage() {
  const { t } = useTranslation();
  const summary = useQuery({ queryKey: queryKeys.summary, queryFn: () => api.summary() });
  const settings = useSettingsQuery();
  const highlightNegativeNet = settings.data?.values.highlightNegativeNet ?? true;

  let body: ReactNode;
  if (summary.data === undefined) {
    body = summary.isError ? (
      <Cascade index={1}>
        <EmptyState
          kind="state"
          icon={TriangleAlert}
          title={t("home.error.title")}
          description={t("home.error.description")}
          action={
            <Button
              variant="secondary"
              loading={summary.isFetching}
              onClick={() => void summary.refetch()}
            >
              {t("home.error.retry")}
            </Button>
          }
        />
      </Cascade>
    ) : (
      <HomeSkeleton />
    );
  } else if (!summary.data.hasConnections) {
    body = (
      <Cascade index={1}>
        <EmptyState
          kind="empty"
          icon={Landmark}
          title={t("home.empty.title")}
          description={t("home.empty.description")}
          action={<ConnectBankButton />}
        />
      </Cascade>
    );
  } else {
    body = <HomeContent summary={summary.data} highlightNegativeNet={highlightNegativeNet} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-8 sm:gap-8">
      <Cascade index={0}>
        <Greeting summary={summary.data} />
      </Cascade>
      {body}
    </div>
  );
}
