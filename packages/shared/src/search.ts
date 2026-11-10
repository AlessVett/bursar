import "./zod-runtime";
import { z } from "zod";
import type { LocalDate } from "./dates";

export const searchQuerySchema = z.object({ q: z.string().trim().min(2).max(100) });
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** At most 6 accounts and 6 transactions. */
export interface SearchResponse {
  accounts: { id: number; name: string; bankName: string; last4: string | null }[];
  transactions: {
    id: number;
    counterparty: string;
    date: LocalDate;
    amountMinor: number;
    currency: string;
    accountName: string;
  }[];
}
