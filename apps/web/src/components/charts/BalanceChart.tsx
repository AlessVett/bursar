import { currencyMinorDigits, type LocalDate } from "@bursar/shared";
import { useId, useMemo } from "react";
import {
  Area,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from "recharts";
import { useFormatters } from "../../lib/format";
import { useUi } from "../../store/ui";
import { Money } from "../ui";
import { useChartColors } from "./chart-colors";

export interface BalancePoint {
  date: LocalDate;
  balanceMinor: number;
}

export interface BalanceChartProps {
  points: BalancePoint[];
  currency: string;
  /** One sentence for screen readers: range, first and last value, lowest and highest value. */
  summaryLabel: string;
  height?: number;
}

/** One plotted row. `x` is the point index; a zero crossing sits between two indices. */
export interface BalanceRow {
  x: number;
  /** Index of the real point closest to `x`, used by the tooltip. */
  index: number;
  positive: number | null;
  negative: number | null;
}

/**
 * Splits a balance series into a non-negative series and a non-positive series so the negative
 * stretches can be drawn in `danger`. Where two neighbouring points have opposite signs an
 * interpolated row at the exact zero crossing closes both series, so the colour changes at zero.
 */
export function buildBalanceRows(points: readonly BalancePoint[]): BalanceRow[] {
  const rows: BalanceRow[] = [];
  points.forEach((point, index) => {
    const value = point.balanceMinor;
    rows.push({
      x: index,
      index,
      positive: value >= 0 ? value : null,
      negative: value <= 0 ? value : null,
    });
    const next = points[index + 1];
    if (next && (value < 0 ? next.balanceMinor > 0 : value > 0 && next.balanceMinor < 0)) {
      const share = value / (value - next.balanceMinor);
      rows.push({
        x: index + share,
        index: share < 0.5 ? index : index + 1,
        positive: 0,
        negative: 0,
      });
    }
  });
  return rows;
}

/** The value axis range: padded by 10 %, kept at zero or above for a series that never dips below. */
export function balanceDomain(values: readonly number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(Math.round((max - min) / 10), 100);
  if (min < 0) return [min - pad, Math.max(max + pad, 0)];
  return [Math.max(min - pad, 0), max + pad];
}

/** Evenly spaced tick positions over point indices (five at most). */
export function axisTicks(count: number): number[] {
  const last = count - 1;
  const steps = Math.min(4, last);
  return Array.from(
    new Set(Array.from({ length: steps + 1 }, (_, k) => Math.round((k * last) / steps))),
  );
}

/** Whole-unit compact money for the value axis: integer division of the minor units, no floats. */
function useAxisFormatter(currency: string): (minor: number) => string {
  const { locale } = useFormatters();
  return useMemo(() => {
    const divisor = 10n ** BigInt(currencyMinorDigits(currency));
    const format = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    });
    return (minor: number) => format.format(BigInt(Math.round(minor)) / divisor);
  }, [locale, currency]);
}

/**
 * Balance over time as an area chart (Recharts). Stretches below zero are drawn in `danger`, the
 * rest in `primary`; the whole chart is one image for assistive technology, described by
 * `summaryLabel`. Needs at least two points and renders nothing otherwise.
 */
export function BalanceChart({ points, currency, summaryLabel, height = 240 }: BalanceChartProps) {
  const gradientId = useId();
  // Task 17's theme-aware chart colours (re-read when `data-theme` changes).
  const colors = useChartColors();
  const { localDate } = useFormatters();
  const privacy = useUi((state) => state.privacy);
  const formatAxis = useAxisFormatter(currency);
  const rows = useMemo(() => buildBalanceRows(points), [points]);
  if (points.length < 2) return null;

  const [low, high] = balanceDomain(points.map((point) => point.balanceMinor));
  const dipsBelowZero = low < 0;
  const hasPositive = rows.some((row) => row.positive !== null);
  const hasNegative = rows.some((row) => row.negative !== null);
  const positiveFill = `${gradientId}-positive`;
  const negativeFill = `${gradientId}-negative`;

  const renderTooltip = ({ active, payload }: TooltipContentProps) => {
    const row = payload?.[0]?.payload as BalanceRow | undefined;
    const point = active && row ? points[row.index] : undefined;
    if (!point) return null;
    return (
      <div className="rounded-lg border border-subtle bg-surface px-3 py-2 text-xs shadow-sm">
        <div className="text-muted">{localDate(point.date, "medium")}</div>
        <div className="text-sm font-semibold">
          <Money minor={point.balanceMinor} currency={currency} tone="auto-balance" />
        </div>
      </div>
    );
  };

  return (
    <div role="img" aria-label={summaryLabel} className="w-full text-muted">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart
          data={rows}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          accessibilityLayer={false}
        >
          <defs>
            <linearGradient id={positiveFill} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.primary} stopOpacity={0.45} />
              <stop offset="100%" stopColor={colors.primary} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={negativeFill} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.danger} stopOpacity={0.02} />
              <stop offset="100%" stopColor={colors.danger} stopOpacity={0.45} />
            </linearGradient>
          </defs>
          <XAxis
            type="number"
            dataKey="x"
            domain={[0, points.length - 1]}
            ticks={axisTicks(points.length)}
            tickFormatter={(value: number) =>
              localDate(points[Math.round(value)]?.date ?? "", "short")
            }
            tickLine={false}
            axisLine={false}
            tick={{ fill: colors.muted, fontSize: 12 }}
            tickMargin={8}
          />
          <YAxis
            hide={privacy}
            domain={[low, high]}
            tickFormatter={formatAxis}
            tickLine={false}
            axisLine={false}
            width={56}
            tick={{ fill: colors.muted, fontSize: 12 }}
          />
          {dipsBelowZero ? <ReferenceLine y={0} stroke={colors.grid} /> : null}
          <Tooltip content={renderTooltip} cursor={{ stroke: colors.grid }} />
          {hasPositive ? (
            <Area
              dataKey="positive"
              type="linear"
              baseValue={dipsBelowZero ? 0 : "dataMin"}
              stroke={colors.primary}
              strokeWidth={2}
              fill={`url(#${positiveFill})`}
              dot={false}
              activeDot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ) : null}
          {hasNegative ? (
            <Area
              dataKey="negative"
              type="linear"
              baseValue={0}
              stroke={colors.danger}
              strokeWidth={2}
              fill={`url(#${negativeFill})`}
              dot={false}
              activeDot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
