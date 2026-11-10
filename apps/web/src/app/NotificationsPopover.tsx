import { Bell, BellOff, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineEmpty, RelativeTime } from "../components/ui";
import { useDismiss } from "./useDismiss";

export interface PopoverNotification {
  id: number;
  title: string;
  body: string;
  at: number;
  read: boolean;
  tone: "warning" | "danger" | "info";
  to: string | null;
}

export interface NotificationsPopoverProps {
  items: PopoverNotification[];
  unread: number;
  onOpenItem(id: number): void;
  onMarkAllRead(): void;
  loading?: boolean;
}

const NO_ITEMS: PopoverNotification[] = [];

/**
 * Data for the popover. This task has no notifications API yet, so the feed is empty; Task 22
 * replaces the body with the `notifications` query.
 */
export function useNotificationsFeed(): NotificationsPopoverProps {
  return {
    items: NO_ITEMS,
    unread: 0,
    onOpenItem: () => undefined,
    onMarkAllRead: () => undefined,
    loading: false,
  };
}

const TONE_ICON = { warning: TriangleAlert, danger: CircleAlert, info: Info } as const;
const TONE_CLASS = {
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
} as const;

/** Bell with an unread badge and a 380 px popover; closes on Esc and on a click outside. */
export function NotificationsPopover({
  items,
  unread,
  onOpenItem,
  onMarkAllRead,
  loading = false,
}: NotificationsPopoverProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();

  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, rootRef, buttonRef);

  const visible = items.slice(0, 6);
  const bellLabel =
    unread > 0
      ? t("notifications.popover.bellUnread", { count: unread })
      : t("notifications.popover.title");

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={bellLabel}
        title={bellLabel}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="relative grid size-11 place-items-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:size-9"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell aria-hidden size={18} strokeWidth={1.75} />
        {unread > 0 ? (
          <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent ring-2 ring-surface" />
        ) : null}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          className="absolute right-0 top-full z-40 mt-2 w-[380px] max-w-[calc(100vw-2rem)] rounded-2xl border border-subtle bg-surface shadow-xl"
        >
          <div className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 id={titleId} className="font-display text-base font-semibold text-fg">
                {t("notifications.popover.title")}
              </h2>
              {unread > 0 ? (
                <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-fg">
                  {t("notifications.popover.newCount", { count: unread })}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              disabled={unread === 0}
              className="rounded-lg px-2 py-1 text-xs font-medium text-primary hover:bg-primary-50 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent"
              onClick={onMarkAllRead}
            >
              {t("notifications.popover.markAllRead")}
            </button>
          </div>
          <div
            className="max-h-[60vh] overflow-y-auto p-2"
            aria-busy={loading ? "true" : undefined}
          >
            {visible.length === 0 ? (
              <div className="px-2 py-6">
                <InlineEmpty
                  icon={BellOff}
                  title={t("notifications.popover.emptyTitle")}
                  description={t("notifications.popover.emptyBody")}
                />
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {visible.map((item) => {
                  const Icon = TONE_ICON[item.tone];
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-2"
                        onClick={() => {
                          setOpen(false);
                          onOpenItem(item.id);
                        }}
                      >
                        <span
                          className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg ${TONE_CLASS[item.tone]}`}
                        >
                          <Icon aria-hidden size={16} strokeWidth={1.75} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-fg">
                              {item.title}
                            </span>
                            {item.read ? null : (
                              <span className="size-2 shrink-0 rounded-full bg-accent">
                                <span className="sr-only">{t("notifications.popover.unread")}</span>
                              </span>
                            )}
                          </span>
                          <span className="line-clamp-2 text-xs text-muted">{item.body}</span>
                          <span className="mt-1 block text-xs text-muted">
                            <RelativeTime at={item.at} />
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
