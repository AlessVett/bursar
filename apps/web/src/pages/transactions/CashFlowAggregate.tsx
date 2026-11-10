import type { CashFlowBucket, CashFlowResponse, LocalDate, TransactionTab } from "@bursar/shared";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CashFlowStrip } from "../../components/charts/CashFlowStrip";
import { Card, Money } from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { amountTone } from "../../lib/tones";
import { useUi } from "../../store/ui";
import type { PeriodRange } from "./period";

export interface CashFlowAggregateProps {
  /** `undefined` while the first response is on its way. */
  aggregate: CashFlowResponse | undefined;
  tab: TransactionTab;
  onTabChange(tab: TransactionTab): void;
  /** A click on a bar: the page turns it into a custom period. */
  onSelectBucket(bucket: CashFlowBucket): void;
  selectedDate: LocalDate | null;
  onCurrencyChange(currency: string): void;
  highlightNegativeNet: boolean;
  /**
   * The period filter's resolved bounds. They name the range shown, because the response bounds
   * collapse to a single day when the filters match nothing. An open side falls back to the response.
   */
  period?: PeriodRange;
}

interface FigureProps {
  label: string;
  hint: string;
  /** Set for the In and Out toggles; Net is a plain button that clears the direction. */
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
}

function Figure({ label, hint, pressed, onClick, children }: FigureProps) {
  return (
    <button
      type="button"
      title={hint}
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-start transition-colors max-sm:min-h-11 sm:w-auto sm:min-w-36 sm:flex-col sm:items-start sm:justify-start sm:gap-0.5 ${
        pressed ? "border-primary bg-primary-50" : "border-subtle hover:bg-surface-2"
      }`}
    >
      <span className="text-xs font-semibold text-muted">{label}</span>
      <span className="font-display text-lg font-bold sm:text-xl">{children}</span>
    </button>
  );
}

/**
 * The aggregated form of the cash-flow strip (UX doc §3): "In · Out · Net" figures that act as
 * direction filters, the period's diverging bars (a click selects that bucket's dates) and, with
 * mixed currencies, a currency switch with the no-conversion note.
 */
export function CashFlowAggregate({
  aggregate,
  tab,
  onTabChange,
  onSelectBucket,
  selectedDate,
  onCurrencyChange,
  highlightNegativeNet,
  period,
}: CashFlowAggregateProps) {
  const { t } = useTranslation();
  const { money, localDate } = useFormatters();
  const privacy = useUi((state) => state.privacy);

  if (!aggregate) {
    return (
      <Card aria-busy="true" className="space-y-4">
        <div className="grid gap-2 sm:flex">
          {[0, 1, 2].map((slot) => (
            <div key={slot} className="h-14 animate-pulse rounded-xl bg-surface-2 sm:w-36" />
          ))}
        </div>
        <div className="h-28 animate-pulse rounded-xl bg-surface-2" />
      </Card>
    );
  }

  const { totals, currency, currencies } = aggregate;
  const mixed = currencies.length > 1;
  const from = localDate(period?.from ?? aggregate.from);
  const to = localDate(period?.to ?? aggregate.to);
  const range = t("transactions.aggregate.range", { from, to });
  const summary = t("transactions.aggregate.summary", {
    from,
    to,
    in: money(totals.inMinor, currency, { sign: "never", masked: privacy }),
    out: money(totals.outMinor, currency, { sign: "never", masked: privacy }),
    net: money(totals.netMinor, currency, { sign: "always", masked: privacy }),
  });

  return (
    <Card padding="none">
      <section aria-label={t("transactions.aggregate.label")} className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap">
            <Figure
              label={t("transactions.aggregate.in")}
              hint={t(
                tab === "in" ? "transactions.aggregate.showAll" : "transactions.aggregate.filterIn",
              )}
              pressed={tab === "in"}
              onClick={() => onTabChange(tab === "in" ? "all" : "in")}
            >
              <Money
                minor={totals.inMinor}
                currency={currency}
                sign="never"
                tone={amountTone(totals.inMinor, "flow")}
              />
            </Figure>
            <Figure
              label={t("transactions.aggregate.out")}
              hint={t(
                tab === "out"
                  ? "transactions.aggregate.showAll"
                  : "transactions.aggregate.filterOut",
              )}
              pressed={tab === "out"}
              onClick={() => onTabChange(tab === "out" ? "all" : "out")}
            >
              <Money
                minor={totals.outMinor}
                currency={currency}
                sign="never"
                tone={amountTone(-Math.abs(totals.outMinor), "flow")}
              />
            </Figure>
            <Figure
              label={t("transactions.aggregate.net")}
              hint={t("transactions.aggregate.showAll")}
              onClick={() => onTabChange("all")}
            >
              <Money
                minor={totals.netMinor}
                currency={currency}
                sign="always"
                tone={amountTone(totals.netMinor, "net", { highlightNegativeNet })}
              />
            </Figure>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
            <p className="tabular text-[13px] text-muted">{range}</p>
            {mixed ? (
              <fieldset className="inline-flex rounded-lg border border-subtle p-0.5">
                <legend className="sr-only">{t("transactions.aggregate.currency")}</legend>
                {currencies.map((code) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={code === currency}
                    onClick={() => onCurrencyChange(code)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold max-sm:min-h-11 ${
                      code === currency ? "bg-primary-50 text-primary" : "text-muted hover:text-fg"
                    }`}
                  >
                    {code}
                  </button>
                ))}
              </fieldset>
            ) : null}
          </div>
        </div>
        {mixed ? (
          <p className="text-[13px] text-muted">{t("transactions.aggregate.mixedNote")}</p>
        ) : null}
        <CashFlowStrip
          buckets={aggregate.buckets}
          currency={currency}
          variant="aggregate"
          highlightNegativeNet={highlightNegativeNet}
          selectedDate={selectedDate}
          onSelectBucket={onSelectBucket}
          height={112}
          summaryLabel={summary}
        />
      </section>
    </Card>
  );
}
