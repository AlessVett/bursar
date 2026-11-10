import { Eye, EyeOff, Menu, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { SaveIndicator } from "../components/ui";
import { useUi } from "../store/ui";
import { usePaletteControl } from "./CommandPalette";
import { NotificationsPopover, useNotificationsFeed } from "./NotificationsPopover";
import { matchRoute } from "./routes";
import { shortcutLabels, usePrivacyToggle } from "./shortcuts";
import { UserMenu } from "./UserMenu";

const ICON_BUTTON =
  "grid size-11 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:size-9";

/** Sticky, translucent topbar: title, palette trigger, save state, privacy, notifications, menu. */
export function Topbar({ onOpenMenu }: { onOpenMenu(): void }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const palette = usePaletteControl();
  const privacy = useUi((state) => state.privacy);
  const togglePrivacy = usePrivacyToggle();
  const feed = useNotificationsFeed();
  const match = matchRoute(pathname);
  const title = match ? t(match.route.titleKey) : t("errors.notFound.title");
  const labels = shortcutLabels();
  const privacyLabel = privacy ? t("privacy.show") : t("privacy.toggle");

  return (
    <header className="sticky top-0 z-20 border-b border-subtle bg-surface/80 backdrop-blur-md">
      <div className="flex h-16 items-center gap-2 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          aria-label={t("nav.open")}
          title={t("nav.open")}
          className={`${ICON_BUTTON} -ml-2 lg:hidden`}
          onClick={onOpenMenu}
        >
          <Menu aria-hidden size={20} strokeWidth={1.75} />
        </button>
        <p className="min-w-0 flex-1 truncate font-display text-base font-semibold text-fg">
          {title}
        </p>
        <button
          type="button"
          aria-label={t("palette.open")}
          className="hidden h-9 w-64 items-center gap-2 rounded-xl border border-subtle bg-surface-2 px-3 text-sm text-muted transition-colors hover:text-fg md:flex"
          onClick={palette.open}
        >
          <Search aria-hidden size={16} strokeWidth={1.75} />
          <span className="flex-1 text-left">{t("palette.trigger")}</span>
          <kbd className="rounded-md border border-subtle bg-surface px-1.5 font-sans text-xs">
            {labels.palette}
          </kbd>
        </button>
        <button
          type="button"
          aria-label={t("palette.open")}
          title={t("palette.open")}
          className={`${ICON_BUTTON} md:hidden`}
          onClick={palette.open}
        >
          <Search aria-hidden size={18} strokeWidth={1.75} />
        </button>
        <div className="hidden sm:block">
          <SaveIndicator />
        </div>
        <button
          type="button"
          aria-label={privacyLabel}
          title={`${privacyLabel} (${labels.privacy})`}
          aria-pressed={privacy}
          className={ICON_BUTTON}
          onClick={togglePrivacy}
        >
          {privacy ? (
            <EyeOff aria-hidden size={18} strokeWidth={1.75} />
          ) : (
            <Eye aria-hidden size={18} strokeWidth={1.75} />
          )}
        </button>
        <NotificationsPopover {...feed} />
        <UserMenu />
      </div>
    </header>
  );
}
