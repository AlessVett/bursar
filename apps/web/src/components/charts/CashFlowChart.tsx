import type { ReactElement } from "react";
import {
  Bar,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { amountTone } from "../../lib/tones";
import {
  CHART_LAYOUT,
  type ChartRow,
  type ChartVariant,
  dayMonthLabel,
  toneColor,
  useChartColors,
} from "./chart-colors";

export interface CashFlowChartProps {
  rows: ChartRow[];
  variant: ChartVariant;
  showBalance: boolean;
  highlightNegativeNet: boolean;
  selectedIndex: number | null;
  height: number;
  locale: string;
}

/** The props Recharts passes to a custom dot renderer that this chart reads. */
interface DotRenderProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: ChartRow;
}

/**
 * Diverging bars around zero: inflows in the positive tone above, outflows in ink below.
 * Red appears only for a negative net (a dot per bucket, through amountTone) and for a
 * negative running balance (a dot on the balance line). The chart is decorative for
 * assistive technology: CashFlowStrip provides the text summary and the keyboard list.
 */
export default function CashFlowChart({
  rows,
  variant,
  showBalance,
  highlightNegativeNet,
  selectedIndex,
  height,
  locale,
}: CashFlowChartProps) {
  const colors = useChartColors();
  const layout = CHART_LAYOUT[variant];
  const opacity = (index: number) => (selectedIndex === null || selectedIndex === index ? 1 : 0.35);

  const netDot = ({ cx, cy, index, payload }: DotRenderProps): ReactElement => {
    const key = `net-${index ?? 0}`;
    if (cx === undefined || cy === undefined || !payload || payload.net === 0) {
      return <g key={key} />;
    }
    const tone = amountTone(payload.net, "net", { highlightNegativeNet });
    return (
      <circle
        key={key}
        cx={cx}
        cy={cy}
        r={3}
        fill={toneColor(colors, tone)}
        stroke={colors.surface}
        strokeWidth={1.5}
      />
    );
  };

  const balanceDot = ({ cx, cy, index, payload }: DotRenderProps): ReactElement => {
    const key = `balance-${index ?? 0}`;
    if (
      cx === undefined ||
      cy === undefined ||
      !payload ||
      payload.balance === null ||
      payload.balance >= 0
    ) {
      return <g key={key} />;
    }
    return <circle key={key} cx={cx} cy={cy} r={2.5} fill={colors.danger} />;
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart
        data={rows}
        margin={layout.margin}
        stackOffset="sign"
        barCategoryGap={variant === "mini" ? "12%" : "24%"}
        accessibilityLayer={false}
      >
        <XAxis
          dataKey="date"
          hide={variant !== "full"}
          height={layout.xAxisHeight}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={24}
          tick={{ fill: colors.muted, fontSize: 12 }}
          tickFormatter={(value: string) => dayMonthLabel(value, locale)}
        />
        <YAxis yAxisId="flow" hide />
        <YAxis yAxisId="balance" orientation="right" hide domain={["dataMin", "dataMax"]} />
        <ReferenceLine yAxisId="flow" y={0} stroke={colors.grid} />
        <Bar
          yAxisId="flow"
          dataKey="inflow"
          stackId="flow"
          fill={colors.positive}
          isAnimationActive={false}
        >
          {rows.map((row, index) => (
            <Cell key={`in-${row.date}`} fillOpacity={opacity(index)} />
          ))}
        </Bar>
        <Bar
          yAxisId="flow"
          dataKey="outflow"
          stackId="flow"
          fill={colors.ink}
          isAnimationActive={false}
        >
          {rows.map((row, index) => (
            <Cell key={`out-${row.date}`} fillOpacity={opacity(index)} />
          ))}
        </Bar>
        {variant === "mini" ? null : (
          <Line
            yAxisId="flow"
            dataKey="net"
            stroke="none"
            dot={netDot}
            activeDot={false}
            isAnimationActive={false}
          />
        )}
        {showBalance ? (
          <Line
            yAxisId="balance"
            type="monotone"
            dataKey="balance"
            stroke={colors.primary}
            strokeWidth={2}
            dot={balanceDot}
            activeDot={false}
            connectNulls
            isAnimationActive={false}
          />
        ) : null}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
