import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../../lib/format";
import { amountTone, toneTextClass } from "../../lib/tones";
import { useUi } from "../../store/ui";

export interface NetChipProps {
  netMinor: number;
  currency: string;
  /** The "highlight negative net" setting; default on, as in the settings defaults. */
  highlightNegativeNet?: boolean;
}

/** The mini form of the cash-flow element: the net of the last 30 days with a direction arrow. */
export function NetChip({ netMinor, currency, highlightNegativeNet = true }: NetChipProps) {
  const { t } = useTranslation();
  const { money } = useFormatters();
  const privacy = useUi((state) => state.privacy);
  const tone = amountTone(netMinor, "net", { highlightNegativeNet });
  const Icon = netMinor > 0 ? ArrowUpRight : netMinor < 0 ? ArrowDownRight : Minus;
  const amount = money(netMinor, currency, { sign: "always", masked: privacy });
  const label = t("cashflow.netChip", {
    amount: privacy ? t("privacy.maskedAmount") : amount,
  });
  return (
    <span
      data-net-chip=""
      data-tone={tone}
      title={label}
      className={`inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold tabular ${toneTextClass(tone)}`}
    >
      <Icon aria-hidden="true" size={14} strokeWidth={2.25} />
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">{amount}</span>
    </span>
  );
}
