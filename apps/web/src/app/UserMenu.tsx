import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleUserRound, LogOut, Monitor, Moon, Sun } from "lucide-react";
import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../api";
import { feedback } from "../components/feedback";
import { type Language, SUPPORTED_LANGUAGES, setLanguage } from "../i18n";
import { isSessionExpired } from "../lib/query-client";
import { queryKeys } from "../lib/query-keys";
import { type Density, type ThemePreference, useUi } from "../store/ui";
import { useDismiss } from "./useDismiss";

const LANGUAGE_LABELS: Record<Language, string> = { it: "Italiano", en: "English" };
const THEMES: readonly { value: ThemePreference; icon: typeof Sun }[] = [
  { value: "system", icon: Monitor },
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
];
const DENSITIES: readonly Density[] = ["compact", "comfortable"];

const OPTION =
  "flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted transition-colors hover:text-fg aria-pressed:bg-surface aria-pressed:text-fg aria-pressed:shadow-sm";

function Segmented({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="px-3 py-2">
      <legend className="mb-1.5 text-xs font-semibold text-muted">{legend}</legend>
      <div className="flex gap-0.5 rounded-xl bg-surface-2 p-0.5">{children}</div>
    </fieldset>
  );
}

/** Topbar menu: language, theme, density and sign out. Closes on Esc and on a click outside. */
export function UserMenu() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const theme = useUi((state) => state.theme);
  const density = useUi((state) => state.density);
  const setTheme = useUi((state) => state.setTheme);
  const setDensity = useUi((state) => state.setDensity);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: async () => {
      queryClient.setQueryData(queryKeys.authStatus, {
        setupRequired: false,
        authenticated: false,
      });
      await navigate("/login", { replace: true });
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== queryKeys.authStatus[0],
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.authStatus });
    },
  });

  // Task 17's useLocaleSync makes the saved locale win on every page load, so the menu saves it.
  const saveLanguage = useMutation({
    mutationFn: (language: Language) => api.updateSettings({ locale: language }),
    onSuccess: (response) => queryClient.setQueryData(queryKeys.settings, response),
    onError: (error) => {
      if (isSessionExpired(error)) return;
      feedback(t("userMenu.languageNotSaved"), t("userMenu.languageNotSavedDetail"), "warning");
    },
  });

  function chooseLanguage(language: Language): void {
    if (i18n.language === language) return;
    setLanguage(language);
    saveLanguage.mutate(language);
  }

  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, rootRef, buttonRef);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={t("userMenu.open")}
        title={t("userMenu.open")}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="grid size-11 place-items-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg sm:size-9"
        onClick={() => setOpen((value) => !value)}
      >
        <CircleUserRound aria-hidden size={20} strokeWidth={1.75} />
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={t("userMenu.title")}
          className="absolute right-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-subtle bg-surface py-2 shadow-xl"
        >
          <Segmented legend={t("common.language")}>
            {SUPPORTED_LANGUAGES.map((language) => (
              <button
                key={language}
                type="button"
                lang={language}
                aria-pressed={i18n.language === language}
                className={OPTION}
                onClick={() => chooseLanguage(language)}
              >
                {LANGUAGE_LABELS[language]}
              </button>
            ))}
          </Segmented>
          <Segmented legend={t("userMenu.theme")}>
            {THEMES.map(({ value, icon: Icon }) => (
              <button
                key={value}
                type="button"
                aria-pressed={theme === value}
                className={OPTION}
                onClick={() => setTheme(value)}
              >
                <Icon aria-hidden size={14} />
                {t(`userMenu.themes.${value}`)}
              </button>
            ))}
          </Segmented>
          <Segmented legend={t("userMenu.density")}>
            {DENSITIES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={density === value}
                className={OPTION}
                onClick={() => setDensity(value)}
              >
                {t(`userMenu.densities.${value}`)}
              </button>
            ))}
          </Segmented>
          <div className="mt-1 border-t border-subtle px-2 pt-2">
            <button
              type="button"
              disabled={logout.isPending}
              className="flex min-h-10 w-full items-center gap-2 rounded-xl px-3 text-sm font-medium text-fg hover:bg-surface-2 disabled:opacity-60"
              onClick={() => logout.mutate()}
            >
              <LogOut aria-hidden size={16} />
              {t("userMenu.signOut")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
