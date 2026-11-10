import { Ellipsis, type LucideIcon } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { useDismiss } from "../../app/useDismiss";
import { IconButton } from "../../components/ui";

export interface MenuAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect(): void;
  /** A blocked action stays visible (UX doc §7 level 2) and explains itself in `disabledReason`. */
  disabled?: boolean;
  disabledReason?: string;
  tone?: "default" | "danger";
  /** Draws a divider above the item: the destructive item goes last, under a divider. */
  separatorBefore?: boolean;
}

/**
 * The “…” menu of a card or a row. Closes on Escape (focus returns to the button), on an outside
 * click and on selection; arrow keys, Home and End move between items. Positioned `absolute`
 * inside a parent without `overflow-hidden`.
 */
export function ActionMenu({ label, actions }: { label: string; actions: readonly MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, rootRef, triggerRef);

  useEffect(() => {
    if (open) itemRefs.current.find((item) => item !== null)?.focus();
  }, [open]);

  function items(): HTMLButtonElement[] {
    return itemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const list = items();
    if (list.length === 0) return;
    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % list.length;
    else if (event.key === "ArrowUp") next = (current - 1 + list.length) % list.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    else if (event.key === "Tab") close();
    if (next !== null) {
      event.preventDefault();
      list[next]?.focus();
    }
  }

  function select(action: MenuAction): void {
    if (action.disabled) return;
    close();
    triggerRef.current?.focus();
    action.onSelect();
  }

  return (
    <div ref={rootRef} className="relative">
      <IconButton
        ref={triggerRef}
        label={label}
        icon={Ellipsis}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="absolute right-0 top-full z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-subtle bg-surface p-1 shadow-xl"
        >
          {actions.map((action, index) => {
            const Icon = action.icon;
            return (
              <div key={action.id}>
                {action.separatorBefore ? <hr className="my-1 border-subtle" /> : null}
                <button
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  aria-disabled={action.disabled || undefined}
                  title={action.disabled ? action.disabledReason : undefined}
                  className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2 focus-visible:bg-surface-2 max-sm:min-h-11 ${
                    action.disabled
                      ? "cursor-not-allowed text-muted"
                      : action.tone === "danger"
                        ? "text-danger"
                        : "text-fg"
                  }`}
                  onClick={() => select(action)}
                >
                  {Icon ? (
                    <Icon aria-hidden size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                  ) : null}
                  <span className="min-w-0">
                    {action.label}
                    {action.disabled && action.disabledReason ? (
                      <span className="mt-0.5 block text-xs font-normal">
                        {action.disabledReason}
                      </span>
                    ) : null}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
