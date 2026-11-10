export type AmountTone = "positive" | "ink" | "danger" | "muted";
export type AmountKind = "flow" | "balance" | "net";

/**
 * Maps a signed amount in minor units to a colour tone. Every amount in the panel goes
 * through this function.
 * - flow (a transaction, an inflow or outflow): > 0 positive, < 0 ink, 0 muted. Spending is
 *   never red.
 * - balance: negative is danger, positive or zero is ink.
 * - net (inflow minus outflow over a period): > 0 positive, < 0 danger unless
 *   `highlightNegativeNet` is false (then ink), 0 muted.
 */
export function amountTone(
  minor: number,
  kind: AmountKind = "flow",
  options: { highlightNegativeNet?: boolean } = {},
): AmountTone {
  if (kind === "balance") return minor < 0 ? "danger" : "ink";
  if (minor > 0) return "positive";
  if (minor < 0) {
    if (kind === "net") return options.highlightNegativeNet === false ? "ink" : "danger";
    return "ink";
  }
  return "muted";
}

/** Full class names are written out so that Tailwind finds them when it scans the sources. */
export function toneTextClass(tone: AmountTone): string {
  switch (tone) {
    case "positive":
      return "text-positive";
    case "danger":
      return "text-danger";
    case "muted":
      return "text-muted";
    default:
      return "text-ink";
  }
}
