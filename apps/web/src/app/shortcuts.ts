import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { feedback } from "../components/feedback";
import { useUi } from "../store/ui";
import { usePaletteControl } from "./CommandPalette";

/** True on macOS and iOS, where shortcuts use ⌘ instead of Ctrl. */
export function isApplePlatform(): boolean {
  const platform = globalThis.navigator?.platform ?? "";
  const agent = globalThis.navigator?.userAgent ?? "";
  return /Mac|iPhone|iPad/.test(platform) || /Mac OS X|iPhone|iPad/.test(agent);
}

/** Display labels for the two global shortcuts on the current platform. */
export function shortcutLabels(): { palette: string; privacy: string } {
  return isApplePlatform()
    ? { palette: "⌘K", privacy: "⇧⌘H" }
    : { palette: "Ctrl K", privacy: "Ctrl Shift H" };
}

/** Toggles privacy mode and announces the new state with an info toast. */
export function usePrivacyToggle(): () => void {
  const { t } = useTranslation();
  return useCallback(() => {
    useUi.getState().togglePrivacy();
    const on = useUi.getState().privacy;
    const shortcut = shortcutLabels().privacy;
    feedback(
      t(on ? "privacy.on" : "privacy.off"),
      t(on ? "privacy.onDetail" : "privacy.offDetail", { shortcut }),
      "info",
    );
  }, [t]);
}

/** ⌘K / Ctrl+K opens the command palette; ⇧⌘H / Ctrl+Shift+H toggles privacy mode. */
export function useGlobalShortcuts(): void {
  const { open } = usePaletteControl();
  const togglePrivacy = usePrivacyToggle();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k" && !event.shiftKey) {
        event.preventDefault();
        open();
      } else if (key === "h" && event.shiftKey) {
        event.preventDefault();
        if (!event.repeat) togglePrivacy();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, togglePrivacy]);
}
