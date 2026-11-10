import {
  type FormatMoneyOptions,
  formatAbsolute,
  formatLocalDate,
  formatMoney,
  formatRelative,
  formatRelativeDay,
  type LocalDate,
  toLocalDate,
} from "@bursar/shared";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";

export interface Formatters {
  locale: string;
  timeZone: string;
  money(minor: number, currency: string, options?: FormatMoneyOptions): string;
  relative(at: number): string;
  absolute(at: number, withTime?: boolean): string;
  localDate(date: LocalDate, style?: "short" | "medium" | "long"): string;
  /** A booking date relative to today in the owner's zone ("Yesterday"; the date beyond 45 days). */
  relativeDay(date: LocalDate): string;
  now(): number;
}

const FormatContext = createContext<string | null>(null);

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The BCP 47 locale used for numbers and dates: Italian for `it`, British English otherwise. */
export function localeFor(language: string): string {
  return language.toLowerCase().startsWith("it") ? "it-IT" : "en-GB";
}

/** Supplies the owner's time zone (the `TZ` setting). Without it the browser's zone is used. */
export function FormatProvider({ timeZone, children }: { timeZone?: string; children: ReactNode }) {
  return <FormatContext.Provider value={timeZone ?? null}>{children}</FormatContext.Provider>;
}

export function useFormatters(): Formatters {
  const { i18n } = useTranslation();
  const configured = useContext(FormatContext);
  const locale = localeFor(i18n.language);
  const timeZone = configured && isTimeZone(configured) ? configured : browserTimeZone();
  return useMemo(
    () => ({
      locale,
      timeZone,
      money: (minor, currency, options) => formatMoney(minor, currency, locale, options),
      relative: (at) => formatRelative(at, Date.now(), locale, timeZone),
      absolute: (at, withTime = false) => formatAbsolute(at, locale, timeZone, { withTime }),
      localDate: (date, style = "medium") => formatLocalDate(date, locale, { style }),
      relativeDay: (date) => formatRelativeDay(date, toLocalDate(Date.now(), timeZone), locale),
      now: () => Date.now(),
    }),
    [locale, timeZone],
  );
}
