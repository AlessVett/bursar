import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface CardProps extends ComponentProps<"div"> {
  padding?: "none" | "md" | "lg";
}

const PADDING = { none: "", md: "p-4", lg: "p-6" } as const;

export function Card({ padding = "md", className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-subtle bg-surface shadow-sm",
        PADDING[padding],
        className,
      )}
      {...props}
    />
  );
}
