import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  /** Disables the button, sets `aria-busy` and swaps the icon for a spinner. */
  loading?: boolean;
  icon?: LucideIcon;
}

const VARIANTS = {
  primary: "bg-primary text-bg hover:opacity-90",
  secondary: "border border-subtle bg-surface text-fg hover:bg-surface-2",
  ghost: "text-fg hover:bg-surface-2",
  danger: "bg-danger text-bg hover:opacity-90",
} as const;

const SIZES = {
  sm: "h-8 gap-1.5 px-3 text-[13px] max-sm:min-h-11",
  md: "h-10 gap-2 px-4 text-sm max-sm:min-h-11",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon: Icon,
  className,
  type = "button",
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <LoaderCircle aria-hidden size={16} strokeWidth={1.75} className="animate-spin" />
      ) : Icon ? (
        <Icon aria-hidden size={16} strokeWidth={1.75} />
      ) : null}
      {children}
    </button>
  );
}
