import { addDays, formatRelativeDay, type LocalDate, localDateSchema } from "@bursar/shared";

export type PeriodPreset = "30d" | "90d" | "12m" | "all" | "custom";

/** Select order of the period filter. */
export const PERIOD_PRESETS: readonly PeriodPreset[] = ["30d", "90d", "12m", "all", "custom"];

/** The Transactions default: Home's 30-day figures link here without date parameters. */
export const DEFAULT_PERIOD = "30d" satisfies PeriodPreset;

export interface PeriodRange {
  from: LocalDate | null;
  to: LocalDate | null;
}

export interface PeriodState extends PeriodRange {
  preset: PeriodPreset;
}

export function isPeriodPreset(value: string): value is PeriodPreset {
  return (PERIOD_PRESETS as readonly string[]).includes(value);
}

/** A real calendar date in `YYYY-MM-DD` form (Task 1 `localDateSchema`). */
export function isLocalDate(value: string | null | undefined): value is LocalDate {
  return typeof value === "string" && localDateSchema.safeParse(value).success;
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of `month` (1-based).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The same calendar day one year earlier, clamped to the month's length (29 Feb → 28 Feb). */
function oneYearEarlier(date: LocalDate): LocalDate {
  const year = Number(date.slice(0, 4)) - 1;
  const month = Number(date.slice(5, 7));
  const day = Math.min(Number(date.slice(8, 10)), daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${date.slice(5, 7)}-${String(day).padStart(2, "0")}`;
}

function presetRange(preset: "30d" | "90d" | "12m", today: LocalDate): PeriodRange {
  if (preset === "30d") return { from: addDays(today, -29), to: today };
  if (preset === "90d") return { from: addDays(today, -89), to: today };
  return { from: addDays(oneYearEarlier(today), 1), to: today };
}

/**
 * The local date bounds of a period. Presets end today (inclusive); `all` has no bounds; `custom`
 * keeps its valid dates (swapped when reversed, one side may be open) and falls back to the
 * default 30 days when neither date is valid. Pure calendar arithmetic: DST cannot move a bound.
 */
export function resolvePeriod(
  input: { period: PeriodPreset; from?: string; to?: string },
  today: LocalDate,
): PeriodRange {
  if (input.period === "all") return { from: null, to: null };
  if (input.period === "custom") {
    const from = isLocalDate(input.from) ? input.from : null;
    const to = isLocalDate(input.to) ? input.to : null;
    if (from === null && to === null) return presetRange(DEFAULT_PERIOD, today);
    if (from !== null && to !== null && from > to) return { from: to, to: from };
    return { from, to };
  }
  return presetRange(input.period, today);
}

/** The preset whose range is exactly `from`–`to` (`all` for no bounds), otherwise `custom`. */
export function periodFromRange(
  from: LocalDate | null,
  to: LocalDate | null,
  today: LocalDate,
): PeriodPreset {
  if (from === null && to === null) return "all";
  if (from !== null && to === today) {
    for (const preset of ["30d", "90d", "12m"] as const) {
      if (presetRange(preset, today).from === from) return preset;
    }
  }
  return "custom";
}

/**
 * Reads the period from raw URL values: an unknown preset is the default; a URL with `from`/`to`
 * but no `period` (Home's "See 14 transactions on 12 Nov" link) is read with `periodFromRange`;
 * a custom period without a valid date is the default; dates next to a preset are ignored.
 */
export function readPeriod(
  input: { period: string; from: string; to: string },
  today: LocalDate,
): PeriodState {
  const from = isLocalDate(input.from) ? input.from : null;
  const to = isLocalDate(input.to) ? input.to : null;
  let preset: PeriodPreset = isPeriodPreset(input.period) ? input.period : DEFAULT_PERIOD;
  if (preset === DEFAULT_PERIOD && (from !== null || to !== null)) {
    preset = periodFromRange(from, to, today);
  }
  if (preset === "custom" && from === null && to === null) preset = DEFAULT_PERIOD;
  const range = resolvePeriod(
    { period: preset, from: from ?? undefined, to: to ?? undefined },
    today,
  );
  return { preset, ...range };
}

/**
 * A transaction day for the list against the page's `today`: Task 1's `formatRelativeDay`, the one
 * relative-day label of the panel (the Account detail tab shows the same text through
 * `useFormatters().relativeDay`).
 */
export function relativeDayLabel(date: LocalDate, today: LocalDate, locale: string): string {
  return formatRelativeDay(date, today, locale);
}
