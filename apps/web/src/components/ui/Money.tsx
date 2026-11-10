import { useTranslation } from "react-i18next";
import { useFormatters } from "../../lib/format";
import { type AmountTone, amountTone, toneTextClass } from "../../lib/tones";
import { useUi } from "../../store/ui";
import { cn } from "./cn";

export interface MoneyProps {
  minor: number;
  currency: string;
  sign?: "auto" | "always" | "never";
  /** A fixed tone, or `auto-*` to derive it from the amount with `amountTone`. */
  tone?: AmountTone | "auto-flow" | "auto-balance" | "auto-net";
  className?: string;
}

function resolveTone(tone: MoneyProps["tone"], minor: number): AmountTone | null {
  if (!tone) return null;
  if (tone === "auto-flow") return amountTone(minor, "flow");
  if (tone === "auto-balance") return amountTone(minor, "balance");
  if (tone === "auto-net") return amountTone(minor, "net");
  return tone;
}

/**
 * The only way the panel renders an amount. In privacy mode it prints the mask and drops the
 * tone, so neither the digits nor the sign leak through the colour.
 */
export function Money({ minor, currency, sign, tone, className }: MoneyProps) {
  const { t } = useTranslation();
  const { money } = useFormatters();
  const privacy = useUi((state) => state.privacy);
  const resolved = privacy ? null : resolveTone(tone, minor);
  const text = money(minor, currency, { sign, masked: privacy });
  return (
    <span
      className={cn("tabular", resolved && toneTextClass(resolved), className)}
      {...(privacy ? { role: "img", "aria-label": t("privacy.maskedAmount") } : {})}
    >
      {text}
    </span>
  );
}
