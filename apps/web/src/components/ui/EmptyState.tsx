import { CircleCheck, FileQuestionMark, Inbox, Info, type LucideIcon, SearchX } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "./cn";

export type EmptyKind = "filter" | "empty" | "positive" | "state" | "notFound";

export interface EmptyStateProps {
  kind: EmptyKind;
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** The first step: a button or a link. */
  action?: ReactNode;
}

const DEFAULT_ICONS: Record<EmptyKind, LucideIcon> = {
  filter: SearchX,
  empty: Inbox,
  positive: CircleCheck,
  state: Info,
  notFound: FileQuestionMark,
};

const ICON_TONES: Record<EmptyKind, string> = {
  filter: "bg-surface-2 text-muted",
  empty: "bg-primary-50 text-primary",
  positive: "bg-surface-2 text-positive",
  state: "bg-info-soft text-info",
  notFound: "bg-surface-2 text-muted",
};

/**
 * Five of the seven empty states of UX doc §7: filter-empty, true-empty (say why and give the
 * first step), positive ("All good"), state-dependent and not found. The sixth is
 * `InlineEmpty` and the seventh, the error state, is the page's own error block.
 */
export function EmptyState({ kind, icon, title, description, action }: EmptyStateProps) {
  const Icon = icon ?? DEFAULT_ICONS[kind];
  return (
    <motion.div
      data-kind={kind}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col items-center px-6 py-12 text-center"
    >
      <span
        className={cn(
          "mb-4 inline-flex size-12 items-center justify-center rounded-2xl",
          ICON_TONES[kind],
        )}
      >
        <Icon aria-hidden size={22} strokeWidth={1.75} />
      </span>
      <p className="font-display text-base font-bold text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </motion.div>
  );
}

export interface InlineEmptyProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
}

/** A small empty inside a card or popover ("No notifications"). */
export function InlineEmpty({ icon: Icon = Inbox, title, description }: InlineEmptyProps) {
  return (
    <motion.div
      data-kind="inline"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex items-center gap-3 px-4 py-6 text-sm text-muted"
    >
      <Icon aria-hidden size={18} strokeWidth={1.75} className="shrink-0" />
      <div>
        <p className="font-medium text-fg">{title}</p>
        {description ? <p>{description}</p> : null}
      </div>
    </motion.div>
  );
}
