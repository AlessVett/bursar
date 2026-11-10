/**
 * Money helpers. Amounts are integer minor units (a JS `number` that must be a safe integer, or a
 * `bigint`) plus an ISO 4217 currency code. Nothing here uses floating-point arithmetic on amounts:
 * parsing and formatting go through exact decimal strings.
 */

/** Thrown by `parseDecimalToMinor` when the input is not an exactly representable amount. */
export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyParseError";
  }
}

/** What privacy mode shows instead of an amount. */
export const MASKED_AMOUNT = "•••••";

const minorDigitsCache = new Map<string, number>();

/**
 * Number of minor-unit digits of a currency (EUR 2, JPY 0, BHD 3), as known to `Intl`.
 * Throws `RangeError` when `currency` is not a well-formed ISO 4217 code.
 */
export function currencyMinorDigits(currency: string): number {
  const code = currency.toUpperCase();
  const cached = minorDigitsCache.get(code);
  if (cached !== undefined) return cached;
  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency: code,
  }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined) throw new RangeError("Unsupported currency");
  minorDigitsCache.set(code, digits);
  return digits;
}

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Converts a provider decimal string ("12.30", "-0.5", "+7") to integer minor units.
 *
 * Only plain decimals with a `.` separator are accepted. Digits beyond the currency's minor digits
 * are accepted only when they are zeros ("1.230" EUR is fine, "1.234" EUR throws), so no amount is
 * ever silently rounded. Throws `MoneyParseError` for anything else and `RangeError` for an invalid
 * currency code. "-0" becomes `0`.
 */
export function parseDecimalToMinor(amount: string, currency: string): number {
  const digits = currencyMinorDigits(currency);
  const match = DECIMAL_PATTERN.exec(amount.trim());
  if (!match) throw new MoneyParseError("Invalid decimal amount");
  const sign = match[1];
  const integerPart = match[2] ?? "";
  const fraction = match[3] ?? "";
  if (/[1-9]/.test(fraction.slice(digits))) {
    throw new MoneyParseError("Amount has more decimals than the currency allows");
  }
  const minor = BigInt(integerPart + fraction.slice(0, digits).padEnd(digits, "0"));
  if (minor > MAX_SAFE_BIGINT) throw new MoneyParseError("Amount is too large");
  const value = Number(minor);
  return sign === "-" && value !== 0 ? -value : value;
}

function toBigInt(minor: bigint | number): bigint {
  if (typeof minor === "bigint") return minor;
  if (!Number.isSafeInteger(minor)) throw new RangeError("Amount is not a safe integer");
  return BigInt(minor);
}

/** Exact decimal string of an amount in minor units: `-1234` EUR becomes `"-12.34"`, JPY `500` becomes `"500"`. */
export function minorToDecimalString(minor: bigint | number, currency: string): string {
  const digits = currencyMinorDigits(currency);
  const value = toBigInt(minor);
  const negative = value < 0n;
  const padded = (negative ? -value : value).toString().padStart(digits + 1, "0");
  const text = digits === 0 ? padded : `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
  return negative ? `-${text}` : text;
}

export interface FormatMoneyOptions {
  /** `auto` shows a minus for negatives only, `always` also shows a plus for positives, `never` formats the absolute value. */
  sign?: "auto" | "always" | "never";
  /** Returns `MASKED_AMOUNT` and no digits (privacy mode). */
  masked?: boolean;
}

const SIGN_DISPLAY = { auto: "auto", always: "exceptZero", never: "never" } as const;
const numberFormatCache = new Map<string, Intl.NumberFormat>();

function currencyFormatter(
  locale: string,
  currency: string,
  signDisplay: (typeof SIGN_DISPLAY)[keyof typeof SIGN_DISPLAY],
): Intl.NumberFormat {
  const key = `${locale}|${currency}|${signDisplay}`;
  let formatter = numberFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      signDisplay,
      // CLDR's it-IT data skips the thousands separator below 10 000 ("1234,50 €"); amounts in a
      // column must group alike, so grouping is forced.
      useGrouping: "always",
    });
    numberFormatCache.set(key, formatter);
  }
  return formatter;
}

/**
 * Formats integer minor units for display. The exact decimal string is handed to
 * `Intl.NumberFormat.format`, which formats strings without going through a double.
 */
export function formatMoney(
  minor: bigint | number,
  currency: string,
  locale: string,
  options: FormatMoneyOptions = {},
): string {
  if (options.masked) return MASKED_AMOUNT;
  const sign = options.sign ?? "auto";
  const decimal = minorToDecimalString(minor, currency.toUpperCase());
  return currencyFormatter(locale, currency.toUpperCase(), SIGN_DISPLAY[sign]).format(
    decimal as `${number}`,
  );
}

/** Exact sum of minor-unit amounts. Throws `RangeError` when an input or the result is not a safe integer. */
export function sumMinor(values: readonly number[]): number {
  let total = 0n;
  for (const value of values) total += toBigInt(value);
  if (total > MAX_SAFE_BIGINT || total < -MAX_SAFE_BIGINT) {
    throw new RangeError("Sum is not a safe integer");
  }
  return Number(total);
}
