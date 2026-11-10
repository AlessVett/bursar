import {
  type AccountStatus,
  addDays,
  type CashFlowBucket,
  type CashFlowResponse,
  diffDays,
  isIncludedInTotals,
  type LocalDate,
  type TransactionStatus,
} from "@bursar/shared";

type BucketSize = CashFlowResponse["bucket"];

/** Longest period (in days, both ends included) drawn with one bar per day. */
const MAX_DAY_BUCKET_DAYS = 92;
/** Longest period drawn with one bar per ISO week; beyond it the bars are months. */
const MAX_WEEK_BUCKET_DAYS = 400;

/** Picks the bar size for a period so the strip never has more than about a hundred bars. */
export function chooseBucket(from: LocalDate, to: LocalDate): BucketSize {
  const days = diffDays(to, from) + 1;
  if (days <= MAX_DAY_BUCKET_DAYS) return "day";
  if (days <= MAX_WEEK_BUCKET_DAYS) return "week";
  return "month";
}

function dateParts(date: LocalDate): { year: number; month: number; day: number } {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return { year, month, day };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** LocalDate years always have four digits (year 202 is "0202"). */
function padYear(year: number): string {
  return String(year).padStart(4, "0");
}

/** First day of the bucket that contains `date` (Monday for weeks, the 1st for months). */
function bucketStart(date: LocalDate, size: BucketSize): LocalDate {
  if (size === "day") return date;
  const { year, month, day } = dateParts(date);
  if (size === "month") return `${padYear(year)}-${pad(month)}-01`;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** Last day of the bucket that starts on `start`. */
function bucketEnd(start: LocalDate, size: BucketSize): LocalDate {
  if (size === "day") return start;
  if (size === "week") return addDays(start, 6);
  const { year, month } = dateParts(start);
  return `${padYear(year)}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
}

function safeAdd(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError("Amount total is not a safe integer");
  return sum;
}

export interface CashFlowRow {
  date: LocalDate;
  amountMinor: number;
  status: TransactionStatus;
}

export interface CashFlowOptions {
  from: LocalDate;
  to: LocalDate;
  currency: string;
  currencies: string[];
  /** The booked balance at the end of `to`; null when it is not known. */
  currentBalanceMinor: number | null;
}

/**
 * Buckets signed amounts of one currency into a zero-filled strip. Pending rows count in the
 * flows and in `count`; only booked rows move the running balance, which is derived backwards from
 * the balance at the end of the period. Rows outside `from`..`to` are ignored.
 */
export function buildCashFlow(
  rows: readonly CashFlowRow[],
  options: CashFlowOptions,
): CashFlowResponse {
  const { from, to } = options;
  if (from > to) throw new RangeError("The period starts after it ends");
  const size = chooseBucket(from, to);

  const buckets: CashFlowBucket[] = [];
  const bookedNet: number[] = [];
  const indexByStart = new Map<LocalDate, number>();
  for (
    let start = bucketStart(from, size);
    start <= to;
    start = addDays(bucketEnd(start, size), 1)
  ) {
    // The first and last bars are clipped to the requested period.
    let first = start;
    if (first < from) first = from;
    let last = bucketEnd(start, size);
    if (last > to) last = to;
    indexByStart.set(start, buckets.length);
    buckets.push({
      date: first,
      end: last,
      inMinor: 0,
      outMinor: 0,
      netMinor: 0,
      count: 0,
      balanceMinor: null,
    });
    bookedNet.push(0);
  }

  const totals = { inMinor: 0, outMinor: 0, netMinor: 0, count: 0 };
  for (const row of rows) {
    if (row.date < from || row.date > to) continue;
    const index = indexByStart.get(bucketStart(row.date, size));
    const bucket = index === undefined ? undefined : buckets[index];
    if (index === undefined || bucket === undefined) continue;
    if (row.amountMinor > 0) {
      bucket.inMinor = safeAdd(bucket.inMinor, row.amountMinor);
      totals.inMinor = safeAdd(totals.inMinor, row.amountMinor);
    } else if (row.amountMinor < 0) {
      bucket.outMinor = safeAdd(bucket.outMinor, -row.amountMinor);
      totals.outMinor = safeAdd(totals.outMinor, -row.amountMinor);
    }
    bucket.netMinor = bucket.inMinor - bucket.outMinor;
    bucket.count += 1;
    totals.count += 1;
    if (row.status === "booked") bookedNet[index] = safeAdd(bookedNet[index] ?? 0, row.amountMinor);
  }
  totals.netMinor = totals.inMinor - totals.outMinor;

  if (options.currentBalanceMinor !== null) {
    let balance = options.currentBalanceMinor;
    for (let index = buckets.length - 1; index >= 0; index -= 1) {
      const bucket = buckets[index];
      if (bucket) bucket.balanceMinor = balance;
      balance -= bookedNet[index] ?? 0;
    }
  }

  return {
    currency: options.currency,
    currencies: options.currencies,
    from,
    to,
    bucket: size,
    buckets,
    totals,
  };
}

/** The currency of the most included accounts; ties go to the alphabetically first code. */
export function defaultCurrency(
  accounts: readonly { currency: string; status: AccountStatus }[],
): string | null {
  const counts = new Map<string, number>();
  for (const account of accounts) {
    if (!isIncludedInTotals(account.status)) continue;
    counts.set(account.currency, (counts.get(account.currency) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [currency, count] of [...counts].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}
