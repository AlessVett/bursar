import "./zod-runtime";
import { z } from "zod";

/**
 * Calendar dates and instants. Instants are epoch milliseconds (or `Date`); a calendar date is a
 * `LocalDate` string `YYYY-MM-DD` that belongs to a time zone chosen by the caller (the `TZ`
 * setting). Day arithmetic works on the proleptic Gregorian calendar with integers only, so it is
 * independent of the process time zone and of daylight saving time.
 */

/** `YYYY-MM-DD`. */
export type LocalDate = string;

/** From this many calendar days away `formatRelative` switches to an absolute date (UX doc §6). */
export const RELATIVE_LIMIT_DAYS = 45;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Civil {
  year: number;
  month: number;
  day: number;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function parseCivil(date: string): Civil | null {
  const match = LOCAL_DATE_PATTERN.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function requireCivil(date: string): Civil {
  const civil = parseCivil(date);
  if (!civil) throw new RangeError("Invalid local date");
  return civil;
}

/** Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm). */
function daysFromCivil({ year, month, day }: Civil): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function civilFromDays(days: number): Civil {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function formatCivil({ year, month, day }: Civil): LocalDate {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A `YYYY-MM-DD` string that is also a real calendar date (no 2026-02-30). */
export const localDateSchema = z
  .string()
  .regex(LOCAL_DATE_PATTERN, "Expected YYYY-MM-DD")
  .refine((value) => parseCivil(value) !== null, "Not a calendar date");

function toMs(instant: Date | number): number {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("Invalid instant");
  return ms;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function localParts(instant: Date | number, timeZone: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(toMs(instant))) {
    parts[part.type] = part.value;
  }
  return parts;
}

/** The calendar date of an instant in a time zone. */
export function toLocalDate(instant: Date | number, timeZone: string): LocalDate {
  const parts = localParts(instant, timeZone);
  return `${(parts.year ?? "").padStart(4, "0")}-${parts.month}-${parts.day}`;
}

/** Adds (or subtracts) whole calendar days. Throws `RangeError` for an invalid date or a non-integer count. */
export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) throw new RangeError("Days must be an integer");
  return formatCivil(civilFromDays(daysFromCivil(requireCivil(date)) + days));
}

/** `a - b` in whole calendar days. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return daysFromCivil(requireCivil(a)) - daysFromCivil(requireCivil(b));
}

/**
 * Epoch milliseconds of the first instant of a local day. Daylight saving time makes days 23 or 25
 * hours long (and a few zones skip midnight), so the instant is found by bisection on `toLocalDate`.
 */
export function startOfLocalDay(date: LocalDate, timeZone: string): number {
  const utcMidnight = daysFromCivil(requireCivil(date)) * MS_PER_DAY;
  // UTC offsets lie between -12:00 and +14:00, so the start of the day is inside this window.
  let before = utcMidnight - 15 * MS_PER_HOUR;
  let after = utcMidnight + 13 * MS_PER_HOUR;
  while (after - before > 1) {
    const middle = before + Math.floor((after - before) / 2);
    if (toLocalDate(middle, timeZone) >= date) after = middle;
    else before = middle;
  }
  return after;
}

/** `HH:MM` (24-hour) of an instant in a time zone. */
export function localTimeOfDay(instant: Date | number, timeZone: string): string {
  const parts = localParts(instant, timeZone);
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${hour}:${parts.minute}`;
}

/**
 * Local calendar days from `now` to `target`, negative when `target` is in the past. Later today is
 * 0 and tomorrow at 00:30 is 1 even when it is 40 minutes away.
 */
export function calendarDaysUntil(
  target: Date | number,
  now: Date | number,
  timeZone: string,
): number {
  return diffDays(toLocalDate(target, timeZone), toLocalDate(now, timeZone));
}

const relativeFormatCache = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  let formatter = relativeFormatCache.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeFormatCache.set(locale, formatter);
  }
  return formatter;
}

/**
 * "now", "5 minutes ago", "in 3 hours", "yesterday", "in 3 days"; from 45 calendar days away in
 * either direction the absolute date (without time) instead. Minutes and hours are elapsed time,
 * days are local calendar days.
 */
export function formatRelative(
  instant: Date | number,
  now: Date | number,
  locale: string,
  timeZone: string,
): string {
  const delta = toMs(instant) - toMs(now);
  const elapsed = Math.abs(delta);
  const formatter = relativeFormatter(locale);
  if (elapsed < MS_PER_MINUTE) return formatter.format(0, "second");
  if (elapsed < MS_PER_HOUR) return formatter.format(Math.trunc(delta / MS_PER_MINUTE), "minute");
  if (elapsed < MS_PER_DAY) return formatter.format(Math.trunc(delta / MS_PER_HOUR), "hour");
  const days = calendarDaysUntil(instant, now, timeZone);
  if (Math.abs(days) >= RELATIVE_LIMIT_DAYS) return formatAbsolute(instant, locale, timeZone);
  return formatter.format(days, "day");
}

const absoluteFormatCache = new Map<string, Intl.DateTimeFormat>();

/** Absolute date ("9 Nov 2026"), with the time ("9 Nov 2026, 14:30") when `withTime` is set. */
export function formatAbsolute(
  instant: Date | number,
  locale: string,
  timeZone: string,
  options: { withTime?: boolean } = {},
): string {
  const withTime = options.withTime === true;
  const key = `${locale}|${timeZone}|${withTime}`;
  let formatter = absoluteFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: "medium",
      ...(withTime ? { timeStyle: "short" as const } : {}),
    });
    absoluteFormatCache.set(key, formatter);
  }
  return formatter.format(toMs(instant));
}

const LOCAL_DATE_FIELDS = {
  short: { day: "numeric", month: "numeric", year: "numeric" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  long: { day: "numeric", month: "long", year: "numeric" },
} as const;

const localDateFormatCache = new Map<string, Intl.DateTimeFormat>();

/** Formats a `LocalDate` without any time zone shift ("9 Nov 2026", with `weekday`: "Mon 9 Nov 2026"). */
export function formatLocalDate(
  date: LocalDate,
  locale: string,
  options: { style?: "short" | "medium" | "long"; weekday?: boolean } = {},
): string {
  const style = options.style ?? "medium";
  const weekday = options.weekday === true;
  const ms = daysFromCivil(requireCivil(date)) * MS_PER_DAY;
  const key = `${locale}|${style}|${weekday}`;
  let formatter = localDateFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      ...LOCAL_DATE_FIELDS[style],
      ...(weekday ? { weekday: style === "long" ? ("long" as const) : ("short" as const) } : {}),
    });
    localDateFormatCache.set(key, formatter);
  }
  return formatter.format(ms);
}

/**
 * A booking date relative to `today`, both calendar days (no time of day, so no time zone or DST
 * shift): "Today", "Yesterday", "3 days ago", "In 2 days" within `RELATIVE_LIMIT_DAYS`, the medium
 * date beyond. Sentence case, because it stands alone in a table cell.
 */
export function formatRelativeDay(date: LocalDate, today: LocalDate, locale: string): string {
  const days = diffDays(date, today);
  if (Math.abs(days) >= RELATIVE_LIMIT_DAYS)
    return formatLocalDate(date, locale, { style: "medium" });
  const label = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
  return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
}
