import type { LocalDate } from "@bursar/shared";

/**
 * Stable dedupe strings for `notifications.dedupe_key`. A key identifies one real-world fact
 * (this consent, with this expiry date, crossed this threshold), so raising it twice is a no-op
 * and a renewed consent (a new `validUntil`) produces a new key.
 */
export const notificationKeys = {
  consentExpiring: (connectionId: number, validUntil: number, threshold: 14 | 3): string =>
    `consent-expiring:${connectionId}:${validUntil}:${threshold}`,
  consentExpired: (connectionId: number, validUntil: number): string =>
    `consent-expired:${connectionId}:${validUntil}`,
  connectionError: (connectionId: number, at: number): string =>
    `connection-error:${connectionId}:${at}`,
  syncFailing: (accountId: number, since: LocalDate | "never"): string =>
    `sync-failing:${accountId}:${since}`,
  backupFailing: (localDate: LocalDate): string => `backup-failing:${localDate}`,
} as const;
