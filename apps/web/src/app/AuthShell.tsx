import { type LucideIcon, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import { type Language, SUPPORTED_LANGUAGES, setLanguage } from "../i18n";
import { type ThemePreference, useUi } from "../store/ui";

const MARK_SIZES = {
  sm: "size-8 rounded-xl text-base",
  md: "size-10 rounded-xl text-lg",
  lg: "size-12 rounded-2xl text-xl",
} as const;

/** The product mark: a monogram on the primary colour (no external image, CSP-safe). */
export function ProductMark({ size = "md" }: { size?: keyof typeof MARK_SIZES }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center bg-primary font-display font-bold text-surface ${MARK_SIZES[size]}`}
    >
      B
    </span>
  );
}

/** An inline error or notice inside an auth card. `alert` is announced immediately. */
export function AuthNotice({ tone, children }: { tone: "danger" | "info"; children: ReactNode }) {
  const classes = tone === "danger" ? "bg-danger-soft text-danger" : "bg-info-soft text-info";
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={`mb-4 rounded-xl px-3 py-2 text-sm ${classes}`}
    >
      {children}
    </p>
  );
}

const LANGUAGE_LABELS: Record<Language, string> = { it: "Italiano", en: "English" };
// Tuples, not an object literal: the source scan in styles/rules.test.ts rejects a dark-colon key.
const THEMES: readonly (readonly [ThemePreference, LucideIcon])[] = [
  ["system", Monitor],
  ["light", Sun],
  ["dark", Moon],
];

const SEGMENT =
  "inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg px-2 text-xs font-medium text-muted transition-colors hover:text-fg aria-pressed:bg-surface aria-pressed:text-fg aria-pressed:shadow-sm";

function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  return (
    <fieldset className="flex gap-0.5 rounded-xl bg-surface-2 p-0.5">
      <legend className="sr-only">{t("common.language")}</legend>
      {SUPPORTED_LANGUAGES.map((language) => (
        <button
          key={language}
          type="button"
          lang={language}
          aria-pressed={i18n.language === language}
          title={LANGUAGE_LABELS[language]}
          className={SEGMENT}
          onClick={() => setLanguage(language)}
        >
          {language.toUpperCase()}
        </button>
      ))}
    </fieldset>
  );
}

function ThemeSwitch() {
  const { t } = useTranslation();
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  return (
    <fieldset className="flex gap-0.5 rounded-xl bg-surface-2 p-0.5">
      <legend className="sr-only">{t("userMenu.theme")}</legend>
      {THEMES.map(([value, Icon]) => {
        const label = t(`userMenu.themes.${value}`);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={theme === value}
            aria-label={label}
            title={label}
            className={SEGMENT}
            onClick={() => setTheme(value)}
          >
            <Icon aria-hidden size={16} strokeWidth={1.75} />
          </button>
        );
      })}
    </fieldset>
  );
}

/** Setup and login: a centred card with the product mark, a language switch and a theme switch. */
export function AuthShell() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex items-center justify-end gap-2 px-4 py-4 sm:px-6">
        <LanguageSwitch />
        <ThemeSwitch />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:pt-12">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center justify-center gap-3">
            <ProductMark size="lg" />
            <span className="font-display text-2xl font-bold text-primary">{t("app.name")}</span>
          </div>
          <div className="rounded-2xl border border-subtle bg-surface p-6 shadow-sm sm:p-8">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
