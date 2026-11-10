import { MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router";
import { Toaster } from "../components/ui";
import { FormatProvider } from "../lib/format";
import { useUi } from "../store/ui";
import { CommandPalette, PaletteProvider } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { useGlobalShortcuts } from "./shortcuts";
import { Topbar } from "./Topbar";
import { LiveEvents } from "./useLiveEvents";
import { useLocaleSync, useSettingsQuery } from "./useSettingsQuery";

function ShortcutBindings() {
  useGlobalShortcuts();
  return null;
}

/**
 * Layout of every signed-in page: sidebar, topbar, the routed page (entry transition only, keyed by
 * pathname, no exit animation), the command palette and the toasts.
 */
export function AppShell() {
  const settings = useSettingsQuery();
  useLocaleSync(settings.data);
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const collapsed = useUi((state) => state.sidebarCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the drawer closes on every route change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <MotionConfig reducedMotion="user">
      <FormatProvider timeZone={settings.data?.system.timezone}>
        <LiveEvents />
        <PaletteProvider>
          <ShortcutBindings />
          <div className="min-h-dvh bg-bg">
            <a
              href="#main"
              className="sr-only z-50 rounded-xl bg-surface px-4 py-2 text-sm font-semibold text-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
            >
              {t("shell.skipToContent")}
            </a>
            <Sidebar drawerOpen={drawerOpen} onCloseDrawer={closeDrawer} />
            <div className={collapsed ? "lg:pl-19" : "lg:pl-66"}>
              <Topbar onOpenMenu={() => setDrawerOpen(true)} />
              <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
                <motion.div
                  key={pathname}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                >
                  <Outlet />
                </motion.div>
              </main>
            </div>
          </div>
          <CommandPalette />
          <Toaster />
        </PaletteProvider>
      </FormatProvider>
    </MotionConfig>
  );
}
