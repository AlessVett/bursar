import { calendarDaysUntil } from "@bursar/shared";

export type Urgency = "danger" | "warning" | "ok";

/** Consent expiry, in local calendar days: red at 3 or fewer (or expired), amber at 14 or fewer. */
export const CONSENT_THRESHOLDS = { dangerDays: 3, warningDays: 14 } as const;

/** Data freshness, in hours since the last successful sync: red above 72, amber above 24. */
export const FRESHNESS_THRESHOLDS = { dangerHours: 72, warningHours: 24 } as const;

const HOUR_MS = 3_600_000;

export function consentUrgency(
  validUntil: number,
  now: number,
  timeZone: string,
): { urgency: Urgency; daysLeft: number; expired: boolean } {
  const daysLeft = calendarDaysUntil(validUntil, now, timeZone);
  const expired = validUntil <= now;
  let urgency: Urgency = "ok";
  if (expired || daysLeft <= CONSENT_THRESHOLDS.dangerDays) urgency = "danger";
  else if (daysLeft <= CONSENT_THRESHOLDS.warningDays) urgency = "warning";
  return { urgency, daysLeft, expired };
}

/** `hours` is the exact elapsed time (never negative); a connection that never synced is `danger`. */
export function freshnessUrgency(
  lastSyncedAt: number | null,
  now: number,
): { urgency: Urgency; hours: number | null } {
  if (lastSyncedAt === null) return { urgency: "danger", hours: null };
  const hours = Math.max(0, now - lastSyncedAt) / HOUR_MS;
  let urgency: Urgency = "ok";
  if (hours > FRESHNESS_THRESHOLDS.dangerHours) urgency = "danger";
  else if (hours > FRESHNESS_THRESHOLDS.warningHours) urgency = "warning";
  return { urgency, hours };
}

/** Full class names are written out so that Tailwind finds them when it scans the sources. */
export function urgencyClasses(urgency: Urgency): string {
  switch (urgency) {
    case "danger":
      return "text-danger bg-danger-soft";
    case "warning":
      return "text-warning bg-warning-soft";
    default:
      return "text-positive bg-surface-2";
  }
}
