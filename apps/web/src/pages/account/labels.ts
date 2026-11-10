import type { SkipReason } from "@bursar/shared";
import type { TFunction } from "i18next";
import { syncErrorText } from "../../app/useLiveEvents";

/**
 * A sentence for a stored error code. It delegates to Task 17's `syncErrorText` (`syncErrors.*`),
 * the one translation of Enable Banking and Bursar codes in the panel, so a toast and this page
 * never word the same code differently; an unknown or missing code gets its generic sentence and
 * the raw code is never shown.
 */
export function errorLabel(t: TFunction, code: string | null): string {
  return syncErrorText(t, code);
}

/** Why a sync run was skipped, in words. */
export function skipReasonLabel(t: TFunction, reason: SkipReason): string {
  return t(`account.skip.${reason}`);
}

/** "Consent expires in 9 days", "Consent expired 3 days ago", or the same-day forms. */
export function consentLabel(t: TFunction, state: { expired: boolean; daysLeft: number }): string {
  const days = Math.abs(state.daysLeft);
  if (state.expired) {
    return days === 0
      ? t("account.consent.expiredToday")
      : t("account.consent.expired", { count: days });
  }
  return days === 0
    ? t("account.consent.expiresToday")
    : t("account.consent.expires", { count: days });
}
