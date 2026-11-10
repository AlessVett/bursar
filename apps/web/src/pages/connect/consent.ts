import { type LocalDate, toLocalDate } from "@bursar/shared";

const DAY_MS = 86_400_000;

/**
 * The server ends a consent this long before the whole-day mark (`CONSENT_SAFETY_MARGIN_MS` in
 * `apps/server/src/finance/connect.ts`, Task 11), so a bank never rejects `valid_until`. The panel
 * subtracts it too, so the date it shows is the date the bank will show.
 */
export const CONSENT_MARGIN_MS = 10 * 60_000;

/** The API accepts 1–365 days (`startConnectionRequestSchema`). */
export const MAX_CONSENT_DAYS = 365;

const PRESET_DAYS = [30, 60, 90, 180, 365] as const;

/** Default duration: the configured duration, capped by what the bank allows. */
export function defaultConsentDays(bankMaxDays: number, settingsDays: number): number {
  return Math.max(1, Math.min(bankMaxDays, settingsDays, MAX_CONSENT_DAYS));
}

/** Sorted, de-duplicated durations: the presets the bank allows, the default and the maximum. */
export function consentOptions(bankMaxDays: number, defaultDays: number): number[] {
  const ceiling = Math.max(1, Math.min(bankMaxDays, MAX_CONSENT_DAYS));
  const days = new Set<number>([defaultDays, ceiling]);
  for (const preset of PRESET_DAYS) {
    if (preset <= ceiling) days.add(preset);
  }
  return [...days].filter((value) => value >= 1 && value <= ceiling).sort((a, b) => a - b);
}

/** Calendar date, in the owner's time zone, on which a consent of `days` days ends. */
export function consentEndDate(now: number, days: number, timeZone: string): LocalDate {
  return toLocalDate(now + days * DAY_MS - CONSENT_MARGIN_MS, timeZone);
}
