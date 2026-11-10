import { Check, CircleAlert, Clock } from "lucide-react";
import { type Urgency, urgencyClasses } from "../../lib/thresholds";
import { cn } from "./cn";

export interface DeadlineChipProps {
  urgency: Urgency;
  /** Always says what is happening ("Consent expires in 9 days"); the colour only reinforces it. */
  label: string;
  title?: string;
  className?: string;
}

const ICONS = { danger: CircleAlert, warning: Clock, ok: Check } as const;

export function DeadlineChip({ urgency, label, title, className }: DeadlineChipProps) {
  const Icon = ICONS[urgency];
  return (
    <span
      data-urgency={urgency}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        urgencyClasses(urgency),
        className,
      )}
    >
      <Icon aria-hidden size={13} strokeWidth={2} />
      {label}
    </span>
  );
}
