import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "../../components/ui/cn";

const BASE =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors max-sm:min-h-11";

const VARIANTS = {
  primary: "bg-primary text-surface hover:opacity-90",
  secondary: "border border-subtle bg-surface text-fg hover:bg-surface-2",
} as const;

export interface LinkButtonProps {
  to: string;
  variant?: keyof typeof VARIANTS;
  icon?: LucideIcon;
  className?: string;
  children: ReactNode;
}

/** A router link that looks like a button: navigation stays a link for the keyboard and for AT. */
export function LinkButton({
  to,
  variant = "primary",
  icon: Icon,
  className,
  children,
}: LinkButtonProps) {
  return (
    <Link to={to} className={cn(BASE, VARIANTS[variant], className)}>
      {Icon ? <Icon aria-hidden size={16} strokeWidth={1.75} /> : null}
      {children}
    </Link>
  );
}
