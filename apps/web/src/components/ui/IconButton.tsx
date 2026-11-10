import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children" | "aria-label"> {
  /** Accessible name and tooltip; icon-only buttons always need one. */
  label: string;
  icon: LucideIcon;
}

export function IconButton({
  label,
  icon: Icon,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-50 max-sm:size-11",
        className,
      )}
      {...props}
    >
      <Icon aria-hidden size={18} strokeWidth={1.75} />
    </button>
  );
}
