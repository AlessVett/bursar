import { createHash } from "node:crypto";
import {
  type LocalDate,
  localDateSchema,
  maskIban,
  maskIdentifier,
  normalizeForSearch,
  parseDecimalToMinor,
  toLocalDate,
} from "@bursar/shared";
import type { EbBalance, EbTransaction } from "../eb/schemas";

/**
 * Turns Enable Banking transactions and balances into the shape Bursar stores.
 *
 * - Amounts become signed integer minor units. The magnitude comes from the provider's decimal
 *   string, the sign only from `credit_debit_indicator` (`DBIT` negative, `CRDT` positive), because
 *   some banks send signed strings and most do not.
 * - `entry_reference` is the stable provider reference. `transaction_id` changes between listings
 *   and is never used.
 * - Counterparty account identifiers are masked before they leave this module.
 */

export interface NormalizedTransaction {
  providerReference: string | null;
  status: "booked" | "pending" | "cancelled";
  bookingDate: LocalDate | null;
  valueDate: LocalDate | null;
  transactionDate: LocalDate | null;
  sortDate: LocalDate;
  amountMinor: number;
  currency: string;
  counterparty: string | null;
  counterpartyAccount: string | null;
  remittance: string | null;
  remittanceLines: string[];
  bankCode: { code: string | null; subCode: string | null; description: string | null } | null;
  merchantCategoryCode: string | null;
  balanceAfterMinor: number | null;
  searchText: string;
  raw: EbTransaction;
}

export interface FingerprintedTransaction extends NormalizedTransaction {
  fingerprint: string;
}

export interface NormalizedBalance {
  balanceType: string;
  amountMinor: number;
  currency: string;
  referenceDate: LocalDate;
  asOf: number;
}

type TransactionState = NormalizedTransaction["status"];

/** Enable Banking `TransactionStatus` codes (eb-api-notes.md §7). */
const STATUS_BY_CODE = new Map<string, TransactionState>([
  ["BOOK", "booked"],
  ["PDNG", "pending"],
  ["HOLD", "pending"],
  ["SCHD", "pending"],
  ["OTHR", "pending"],
  ["CNCL", "cancelled"],
  ["RJCT", "cancelled"],
]);

/** `YYYY-MM-DD`, optionally followed by a time part that is ignored. */
const DATE_PART = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/;
/** A date-time with an explicit offset; anything else would be read in the process time zone. */
const OFFSET_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function cleanName(value: string | null | undefined): string | null {
  return trimmedOrNull(typeof value === "string" ? value.replace(/\s+/g, " ") : value);
}

function calendarDate(value: string | null | undefined): LocalDate | null {
  if (typeof value !== "string") return null;
  const date = DATE_PART.exec(value.trim())?.[1];
  if (date === undefined) return null;
  return localDateSchema.safeParse(date).success ? date : null;
}

function instant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!OFFSET_DATE_TIME.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function mapStatus(code: string): TransactionState {
  return STATUS_BY_CODE.get(code.trim().toUpperCase()) ?? "pending";
}

function signedAmount(tx: EbTransaction, currency: string): number {
  const magnitude = Math.abs(parseDecimalToMinor(tx.transaction_amount.amount, currency));
  if (magnitude === 0) return 0;
  return tx.credit_debit_indicator === "DBIT" ? -magnitude : magnitude;
}

function maskedAccount(account: EbTransaction["creditor_account"]): string | null {
  const iban = trimmedOrNull(account?.iban);
  if (iban !== null) return maskIban(iban);
  const other = trimmedOrNull(account?.other?.identification);
  return other === null ? null : maskIdentifier(other);
}

function bankCode(code: EbTransaction["bank_transaction_code"]): NormalizedTransaction["bankCode"] {
  if (!code) return null;
  const value = {
    code: trimmedOrNull(code.code),
    subCode: trimmedOrNull(code.sub_code),
    description: trimmedOrNull(code.description),
  };
  return value.code === null && value.subCode === null && value.description === null ? null : value;
}

function balanceAfter(
  balance: EbTransaction["balance_after_transaction"],
  currency: string,
): number | null {
  if (!balance || balance.currency.trim().toUpperCase() !== currency) return null;
  try {
    return parseDecimalToMinor(balance.amount, currency);
  } catch {
    return null;
  }
}

/** Matching key for counterparties: lower case, no accents, single spaces; `""` when unknown. */
export function normalizeCounterparty(name: string | null): string {
  return normalizeForSearch(name ?? "");
}

/**
 * Normalises one Enable Banking transaction. `fallbackDate` (normally today in the configured time
 * zone) becomes the sort date when the bank sends no usable date. Throws `MoneyParseError` when the
 * amount is not a plain decimal and `RangeError` when `fallbackDate` is not a calendar date.
 */
export function normalizeTransaction(
  tx: EbTransaction,
  fallbackDate: LocalDate,
): NormalizedTransaction {
  const fallback = calendarDate(fallbackDate);
  if (fallback === null) throw new RangeError("Invalid fallback date");
  const currency = tx.transaction_amount.currency.trim().toUpperCase();
  const debit = tx.credit_debit_indicator === "DBIT";
  const bookingDate = calendarDate(tx.booking_date);
  const valueDate = calendarDate(tx.value_date);
  const transactionDate = calendarDate(tx.transaction_date);
  const counterparty = cleanName((debit ? tx.creditor : tx.debtor)?.name);
  const remittanceLines = (tx.remittance_information ?? [])
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const remittance = remittanceLines.length > 0 ? remittanceLines.join(" ") : null;
  return {
    providerReference: trimmedOrNull(tx.entry_reference),
    status: mapStatus(tx.status),
    bookingDate,
    valueDate,
    transactionDate,
    sortDate: bookingDate ?? valueDate ?? transactionDate ?? fallback,
    amountMinor: signedAmount(tx, currency),
    currency,
    counterparty,
    counterpartyAccount: maskedAccount(debit ? tx.creditor_account : tx.debtor_account),
    remittance,
    remittanceLines,
    bankCode: bankCode(tx.bank_transaction_code),
    merchantCategoryCode: trimmedOrNull(tx.merchant_category_code),
    balanceAfterMinor: balanceAfter(tx.balance_after_transaction, currency),
    searchText: normalizeForSearch(`${counterparty ?? ""} ${remittance ?? ""}`),
    raw: tx,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stands in for the date in the key of an entry the provider sent without any date. */
const NO_PROVIDER_DATE = "nodate";

/** True when the provider sent at least one date (booking, value or transaction). */
export function hasProviderDate(tx: NormalizedTransaction): boolean {
  return tx.bookingDate !== null || tx.valueDate !== null || tx.transactionDate !== null;
}

/**
 * Adds the deduplication key (spec §6.3). With an `entry_reference`: `ref:<reference>`. Without:
 * `fp:<hash>#<n>` for booked entries and `pending:<hash>#<n>` for pending and cancelled ones, where
 * the hash covers account, the provider's first date (booking, value, transaction, else the
 * constant `nodate`, never the fallback day), amount, currency, normalised counterparty and the
 * remittance hash, and `n` counts identical hashes in provider order, so two identical payments
 * on the same day stay two rows and keep their keys on the next sync.
 */
export function assignFingerprints(
  accountId: number,
  txs: readonly NormalizedTransaction[],
): FingerprintedTransaction[] {
  const occurrences = new Map<string, number>();
  return txs.map((tx) => {
    if (tx.providerReference !== null) {
      return { ...tx, fingerprint: `ref:${tx.providerReference}` };
    }
    const hash = sha256Hex(
      [
        String(accountId),
        tx.bookingDate ?? tx.valueDate ?? tx.transactionDate ?? NO_PROVIDER_DATE,
        String(tx.amountMinor),
        tx.currency,
        normalizeCounterparty(tx.counterparty),
        sha256Hex(tx.remittance ?? ""),
      ].join("|"),
    );
    const base = `${tx.status === "booked" ? "fp" : "pending"}:${hash}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { ...tx, fingerprint: `${base}#${occurrence}` };
  });
}

/**
 * Normalises one balance. `referenceDate` is the bank's `reference_date`, else the local day of
 * `last_change_date_time`, else the local day of `fetchedAt`; `asOf` is the change time when the
 * bank sends one with an offset, else `fetchedAt`.
 */
export function normalizeBalance(
  balance: EbBalance,
  fetchedAt: number,
  timeZone: string,
): NormalizedBalance {
  const currency = balance.balance_amount.currency.trim().toUpperCase();
  const changedAt = instant(balance.last_change_date_time);
  return {
    balanceType: balance.balance_type.trim().toUpperCase(),
    amountMinor: parseDecimalToMinor(balance.balance_amount.amount, currency),
    currency,
    referenceDate:
      calendarDate(balance.reference_date) ?? toLocalDate(changedAt ?? fetchedAt, timeZone),
    asOf: changedAt ?? fetchedAt,
  };
}
