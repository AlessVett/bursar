import { cn } from "./cn";

export interface StatusPillProps {
  tone: "positive" | "warning" | "danger" | "info" | "neutral";
  /** The state name, always visible: colour is never the only signal. */
  label: string;
  className?: string;
}

const TONES = {
  positive: { pill: "text-positive bg-surface-2", dot: "bg-positive" },
  warning: { pill: "text-warning bg-warning-soft", dot: "bg-warning" },
  danger: { pill: "text-danger bg-danger-soft", dot: "bg-danger" },
  info: { pill: "text-info bg-info-soft", dot: "bg-info" },
  neutral: { pill: "text-muted bg-surface-2", dot: "bg-muted" },
} as const;

export function StatusPill({ tone, label, className }: StatusPillProps) {
  const classes = TONES[tone];
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        classes.pill,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", classes.dot)} />
      {label}
    </span>
  );
}
