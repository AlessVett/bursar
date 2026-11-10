import type { ReactNode } from "react";
import { cn } from "./cn";

export interface BadgeProps {
  /** `neutral` shows a total; `accent` shows a count that needs action. */
  tone: "neutral" | "accent";
  count?: number;
  children?: ReactNode;
  className?: string;
}

export function Badge({ tone, count, children, className }: BadgeProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "tabular inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold leading-5",
        tone === "accent" ? "bg-accent text-on-accent" : "bg-surface-2 text-muted",
        className,
      )}
    >
      {children ?? count}
    </span>
  );
}
