import "./zod-runtime";
import { z } from "zod";
import { type LocalDate, localDateSchema } from "./dates";
import type { TransactionStatus } from "./finance";

export const transactionTabSchema = z.enum(["all", "in", "out", "pending"]);
export type TransactionTab = z.infer<typeof transactionTabSchema>;

const currencyParam = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());

const accountIdParam = z.coerce.number().int().positive();

/** Rejects a period whose start is after its end. */
function periodIsOrdered(value: {
  from?: LocalDate | undefined;
  to?: LocalDate | undefined;
}): boolean {
  return value.from === undefined || value.to === undefined || value.from <= value.to;
}
const PERIOD_ISSUE = { path: ["to"], message: "`to` must not be before `from`" };

/** Query string of `GET /api/transactions` (every value arrives as text, so numbers are coerced). */
export const transactionQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(100)
      .transform((value) => (value === "" ? undefined : value))
      .optional(),
    accountId: accountIdParam.optional(),
    tab: transactionTabSchema.default("all"),
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    currency: currencyParam.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce
      .number()
      .pipe(z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]))
      .default(20),
    sort: z.enum(["date", "amount", "counterparty"]).default("date"),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .refine(periodIsOrdered, PERIOD_ISSUE);
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;

/** Query string of `GET /api/cashflow`. */
export const cashflowQuerySchema = z
  .object({
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    accountId: accountIdParam.optional(),
    currency: currencyParam.optional(),
  })
  .refine(periodIsOrdered, PERIOD_ISSUE);
export type CashflowQuery = z.infer<typeof cashflowQuerySchema>;

export interface TransactionItem {
  id: number;
  accountId: number;
  accountName: string;
  status: TransactionStatus;
  date: LocalDate;
  bookingDate: LocalDate | null;
  valueDate: LocalDate | null;
  amountMinor: number;
  currency: string;
  counterparty: string | null;
  description: string | null;
}

export interface TransactionDetail extends TransactionItem {
  transactionDate: LocalDate | null;
  providerReference: string | null;
  counterpartyAccount: string | null;
  remittanceLines: string[];
  bankCode: { code: string | null; subCode: string | null; description: string | null } | null;
  merchantCategoryCode: string | null;
  balanceAfter: { amountMinor: number; currency: string } | null;
  firstSeenAt: number;
  lastSeenAt: number;
  bankName: string;
}

/**
 * One bar of the cash-flow strip. `date`..`end` is the covered range clipped to the requested
 * period; `outMinor` is a positive magnitude, so `netMinor = inMinor - outMinor`; `balanceMinor` is
 * the booked balance at the end of `end`, or null when it is unknown.
 */
export interface CashFlowBucket {
  date: LocalDate;
  end: LocalDate;
  inMinor: number;
  outMinor: number;
  netMinor: number;
  count: number;
  balanceMinor: number | null;
}

export interface CashFlowResponse {
  currency: string;
  currencies: string[];
  from: LocalDate;
  to: LocalDate;
  bucket: "day" | "week" | "month";
  buckets: CashFlowBucket[];
  totals: { inMinor: number; outMinor: number; netMinor: number; count: number };
}

export interface TransactionListResponse {
  items: TransactionItem[];
  total: number;
  page: number;
  pageSize: number;
  facets: Record<TransactionTab, number>;
  aggregate: CashFlowResponse;
}
