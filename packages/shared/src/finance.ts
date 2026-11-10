import { z } from "zod";
import { calendarDaysUntil } from "./dates";

export const storedConnectionStatusSchema = z.enum(["active", "expired", "revoked", "error"]);
export const connectionStatusSchema = z.enum(["active", "expiring", "expired", "revoked", "error"]);
export const accountStatusSchema = z.enum(["active", "disabled", "unavailable", "removed"]);
export const syncTriggerSchema = z.enum(["initial", "manual", "background", "renewal"]);
export const syncRunStatusSchema = z.enum(["running", "succeeded", "failed", "skipped"]);
export const skipReasonSchema = z.enum([
  "rate_limited",
  "daily_cap",
  "connection_inactive",
  "account_inactive",
  "no_provider_uid",
]);
export const transactionStatusSchema = z.enum(["booked", "pending"]);
export const notificationEventSchema = z.enum([
  "consent_expiring",
  "consent_expired",
  "connection_error",
  "sync_failing",
  "backup_failing",
]);
export const backupRunStatusSchema = z.enum(["running", "succeeded", "failed"]);

export type StoredConnectionStatus = z.infer<typeof storedConnectionStatusSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type SyncTrigger = z.infer<typeof syncTriggerSchema>;
export type SyncRunStatus = z.infer<typeof syncRunStatusSchema>;
export type SkipReason = z.infer<typeof skipReasonSchema>;
export type TransactionStatus = z.infer<typeof transactionStatusSchema>;
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
export type BackupRunStatus = z.infer<typeof backupRunStatusSchema>;

/** A connection with this many calendar days (or fewer) left is shown as expiring. */
export const EXPIRING_THRESHOLD_DAYS = 14;
/** At this many calendar days (or fewer) the consent renewal is urgent. */
export const URGENT_THRESHOLD_DAYS = 3;

/**
 * Status shown in the panel: the stored status wins unless it is `active`, in which case the
 * consent end date decides between `expired`, `expiring` and `active`.
 */
export function effectiveConnectionStatus(
  stored: StoredConnectionStatus,
  validUntil: number,
  now: number,
  timeZone: string,
): ConnectionStatus {
  if (stored !== "active") return stored;
  if (validUntil <= now) return "expired";
  if (calendarDaysUntil(validUntil, now, timeZone) <= EXPIRING_THRESHOLD_DAYS) return "expiring";
  return "active";
}

/** Balance types in the order the panel prefers them as "the" balance of an account. */
export const PREFERRED_BALANCE_TYPES = [
  "ITBD",
  "CLBD",
  "ITAV",
  "CLAV",
  "XPCD",
  "OPBD",
  "OPAV",
  "PRCD",
  "FWAV",
  "VALU",
  "INFO",
  "OTHR",
] as const;

/** The most preferred balance; unknown types rank after every known one; ties keep input order. */
export function pickPreferredBalance<T extends { balanceType: string }>(
  balances: readonly T[],
): T | null {
  const rank = (balanceType: string): number => {
    const index = (PREFERRED_BALANCE_TYPES as readonly string[]).indexOf(balanceType);
    return index === -1 ? PREFERRED_BALANCE_TYPES.length : index;
  };
  let best: T | null = null;
  for (const balance of balances) {
    if (best === null || rank(balance.balanceType) < rank(best.balanceType)) best = balance;
  }
  return best;
}

/** Fallback names for accounts the bank gives no product name or description. */
export const CASH_ACCOUNT_TYPE_LABELS: Record<
  "it" | "en",
  Record<"CACC" | "CASH" | "CARD" | "LOAN" | "SVGS" | "OTHR", string>
> = {
  it: {
    CACC: "Conto corrente",
    CASH: "Conto di cassa",
    CARD: "Carta",
    LOAN: "Finanziamento",
    SVGS: "Risparmio",
    OTHR: "Conto",
  },
  en: {
    CACC: "Current account",
    CASH: "Cash account",
    CARD: "Card",
    LOAN: "Loan",
    SVGS: "Savings",
    OTHR: "Account",
  },
};

function filled(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** nickname, then product, then details, then "<type label> ••<last4>". */
export function accountDisplayName(
  input: {
    nickname: string | null;
    product: string | null;
    details: string | null;
    cashAccountType: string | null;
    last4: string | null;
  },
  locale: "it" | "en",
): string {
  const named = filled(input.nickname) ?? filled(input.product) ?? filled(input.details);
  if (named) return named;
  const labels = CASH_ACCOUNT_TYPE_LABELS[locale];
  const label =
    input.cashAccountType !== null && Object.hasOwn(labels, input.cashAccountType)
      ? labels[input.cashAccountType as keyof typeof labels]
      : labels.OTHR;
  const last4 = filled(input.last4);
  return last4 ? `${label} ••${last4}` : label;
}

/** Accounts counted in totals: `active`, and `unavailable` ones keep their last known balance. */
export function isIncludedInTotals(status: AccountStatus): boolean {
  return status === "active" || status === "unavailable";
}
