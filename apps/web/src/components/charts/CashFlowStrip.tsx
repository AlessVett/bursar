import { type CashFlowBucket, type LocalDate, sumMinor } from "@bursar/shared";
import {
  type CSSProperties,
  type KeyboardEvent,
  lazy,
  Suspense,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../../lib/format";
import { type AmountTone, amountTone, toneTextClass } from "../../lib/tones";
import { useUi } from "../../store/ui";
import { bucketLabel, type ChartRow, type ChartVariant, overlayInset } from "./chart-colors";

const CashFlowChart = lazy(() => import("./CashFlowChart"));

export interface CashFlowStripProps {
  buckets: CashFlowBucket[];
  currency: string;
  variant: "full" | "mini" | "aggregate";
  showBalance?: boolean;
  highlightNegativeNet: boolean;
  selectedDate?: LocalDate | null;
  onSelectBucket?: (bucket: CashFlowBucket) => void;
  height?: number;
  summaryLabel: string;
}

export const STRIP_HEIGHT: Record<ChartVariant, number> = { full: 220, mini: 40, aggregate: 96 };

/** `outMinor` is a non-negative magnitude (Task 16); outflows are plotted below zero. */
export function toChartRows(buckets: readonly CashFlowBucket[]): ChartRow[] {
  return buckets.map((bucket) => ({
    date: bucket.date,
    inflow: Math.abs(bucket.inMinor),
    outflow: -Math.abs(bucket.outMinor),
    net: bucket.netMinor,
    balance: bucket.balanceMinor,
  }));
}

function tooltipPosition(index: number, total: number): CSSProperties {
  const ratio = (index + 0.5) / Math.max(1, total);
  const shift = ratio < 0.2 ? "0%" : ratio > 0.8 ? "-100%" : "-50%";
  return { left: `${ratio * 100}%`, transform: `translateX(${shift})` };
}

function TooltipRow({ label, value, tone }: { label: string; value: string; tone: AmountTone }) {
  return (
    <p className="flex justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className={`tabular font-medium ${toneTextClass(tone)}`}>{value}</span>
    </p>
  );
}

/**
 * The iconic cash-flow strip (UX doc §3). `full` is the Home form (dates, balance line,
 * tooltip, selectable days), `aggregate` the Transactions form (bars only, selectable),
 * `mini` the account-card form (bars only, no interaction). Every form has a text summary
 * for screen readers, and every amount honours privacy mode.
 */
export function CashFlowStrip({
  buckets,
  currency,
  variant,
  showBalance,
  highlightNegativeNet,
  selectedDate = null,
  onSelectBucket,
  height,
  summaryLabel,
}: CashFlowStripProps) {
  const { t } = useTranslation();
  const { money, localDate, locale } = useFormatters();
  const privacy = useUi((state) => state.privacy);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const rows = useMemo(() => toChartRows(buckets), [buckets]);

  const withBalance = showBalance ?? variant === "full";
  const chartHeight = height ?? STRIP_HEIGHT[variant];
  const interactive = variant !== "mini" && buckets.length > 0;
  const selectedIndex = selectedDate ? buckets.findIndex((b) => b.date === selectedDate) : -1;
  const rovingIndex = focusIndex ?? (selectedIndex >= 0 ? selectedIndex : buckets.length - 1);
  const inset = overlayInset(variant);
  const insetStyle: CSSProperties = { ...inset };

  const format = (minor: number, sign: "auto" | "always" = "auto") =>
    money(minor, currency, { sign, masked: privacy });
  const netTone = (minor: number) => amountTone(minor, "net", { highlightNegativeNet });

  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  let summary = t("cashflow.srEmpty", { label: summaryLabel });
  if (first && last) {
    summary = t("cashflow.srSummary", {
      label: summaryLabel,
      from: localDate(first.date, "medium"),
      to: localDate(last.end, "medium"),
      in: format(sumMinor(buckets.map((b) => Math.abs(b.inMinor)))),
      out: format(sumMinor(buckets.map((b) => Math.abs(b.outMinor)))),
      net: format(sumMinor(buckets.map((b) => b.netMinor)), "always"),
    });
    if (withBalance && last.balanceMinor !== null) {
      summary += ` ${t("cashflow.srBalance", { balance: format(last.balanceMinor) })}`;
    }
  }

  const bucketName = (bucket: CashFlowBucket) =>
    t("cashflow.bucket", {
      count: bucket.count,
      date: bucketLabel(bucket, locale),
      in: format(Math.abs(bucket.inMinor)),
      out: format(Math.abs(bucket.outMinor)),
      net: format(bucket.netMinor, "always"),
    });

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = buckets.length - 1;
    let target: number | null = null;
    if (event.key === "ArrowRight") target = index + 1;
    else if (event.key === "ArrowLeft") target = index - 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = lastIndex;
    if (target === null) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(lastIndex, target));
    setFocusIndex(next);
    buttons.current[next]?.focus();
  };

  const active = activeIndex === null ? null : (buckets[activeIndex] ?? null);

  return (
    <figure aria-label={summaryLabel} className="relative m-0 w-full">
      <p className="sr-only">{summary}</p>
      <div className="relative w-full" style={{ height: chartHeight }}>
        <div aria-hidden="true" className="absolute inset-0">
          <Suspense
            fallback={<div className="h-full w-full animate-pulse rounded-xl bg-surface-2" />}
          >
            <CashFlowChart
              rows={rows}
              variant={variant}
              showBalance={withBalance}
              highlightNegativeNet={highlightNegativeNet}
              selectedIndex={selectedIndex >= 0 ? selectedIndex : null}
              height={chartHeight}
              locale={locale}
            />
          </Suspense>
        </div>
        {interactive ? (
          <ol
            aria-label={t("cashflow.periods", { label: summaryLabel })}
            className="absolute flex"
            style={insetStyle}
          >
            {buckets.map((bucket, index) => (
              <li key={bucket.date} className="flex min-w-0 flex-1">
                <button
                  type="button"
                  ref={(element) => {
                    buttons.current[index] = element;
                  }}
                  tabIndex={index === rovingIndex ? 0 : -1}
                  aria-label={bucketName(bucket)}
                  aria-pressed={onSelectBucket ? index === selectedIndex : undefined}
                  onClick={() => onSelectBucket?.(bucket)}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  onFocus={() => {
                    setFocusIndex(index);
                    setActiveIndex(index);
                  }}
                  onBlur={() => setActiveIndex(null)}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseLeave={() => setActiveIndex(null)}
                  className={`w-full rounded-md transition-colors ${
                    index === selectedIndex ? "bg-primary/10" : "hover:bg-fg/5"
                  }`}
                />
              </li>
            ))}
          </ol>
        ) : null}
        {interactive && active && activeIndex !== null ? (
          <div aria-hidden="true" className="pointer-events-none absolute" style={insetStyle}>
            <div
              className="absolute top-0 z-10 w-max max-w-56 rounded-xl border border-subtle bg-surface px-3 py-2 text-xs shadow-lg"
              style={tooltipPosition(activeIndex, buckets.length)}
            >
              <p className="mb-1 font-medium text-fg">{bucketLabel(active, locale)}</p>
              <TooltipRow
                label={t("cashflow.in")}
                value={format(Math.abs(active.inMinor))}
                tone={amountTone(Math.abs(active.inMinor))}
              />
              <TooltipRow
                label={t("cashflow.out")}
                value={format(Math.abs(active.outMinor))}
                tone={active.outMinor === 0 ? "muted" : "ink"}
              />
              <TooltipRow
                label={t("cashflow.net")}
                value={format(active.netMinor, "always")}
                tone={netTone(active.netMinor)}
              />
              {withBalance && active.balanceMinor !== null ? (
                <TooltipRow
                  label={t("cashflow.balance")}
                  value={format(active.balanceMinor)}
                  tone={amountTone(active.balanceMinor, "balance")}
                />
              ) : null}
              <p className="mt-1 text-muted">{t("cashflow.count", { count: active.count })}</p>
            </div>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
