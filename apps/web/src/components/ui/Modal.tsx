import { X } from "lucide-react";
import { motion } from "motion/react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useBodyScrollLock, useFocusTrap } from "../../lib/focus-trap";
import { cn } from "./cn";
import { IconButton } from "./IconButton";

export interface ModalProps {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  placement: "center" | "right";
  /** Width in pixels of a right-hand panel; it is full width below 640 px. */
  width?: number;
  role?: "dialog" | "alertdialog";
  /** When false, Esc and a click on the backdrop do nothing (a request is in flight). */
  dismissible?: boolean;
}

/**
 * Shared shell of `Drawer` and `Dialog`: portal, backdrop, `aria-modal`, focus trap, Esc, body
 * scroll lock. It animates on entry only. Esc is handled on the panel and stopped there, so an
 * overlay opened from inside another one closes alone.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  placement,
  width = 520,
  role = "dialog",
  dismissible = true,
}: ModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useFocusTrap(panel, open);
  useBodyScrollLock(open);
  if (!open) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (dismissible) onClose();
  }

  const right = placement === "right";
  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex",
        right ? "justify-end" : "items-center justify-center p-4",
      )}
    >
      <div
        aria-hidden
        data-backdrop
        className="absolute inset-0 bg-bg/60 backdrop-blur-sm"
        onClick={dismissible ? onClose : undefined}
      />
      <motion.div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        initial={right ? { opacity: 0, x: 32 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, x: 0, y: 0 }}
        transition={{ duration: 0.2 }}
        style={right ? ({ "--drawer-width": `${width}px` } as CSSProperties) : undefined}
        className={cn(
          "relative flex flex-col bg-surface text-fg shadow-xl outline-none",
          right
            ? "h-full w-full sm:w-[var(--drawer-width)]"
            : "max-h-full w-full max-w-md rounded-2xl",
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-subtle px-5 py-4">
          <h2 id={titleId} className="min-w-0 truncate font-display text-lg font-bold">
            {title}
          </h2>
          <IconButton
            label={t("dialog.close")}
            icon={X}
            onClick={onClose}
            disabled={!dismissible}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-subtle px-5 py-3">
            {footer}
          </div>
        ) : null}
      </motion.div>
    </div>,
    document.body,
  );
}
