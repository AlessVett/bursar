import "./zod-runtime";
import { z } from "zod";
import type { LocalDate } from "./dates";
import type {
  AccountStatus,
  ConnectionStatus,
  SkipReason,
  SyncRunStatus,
  SyncTrigger,
} from "./finance";
import type { CashFlowBucket } from "./transactions";

export interface AccountSummary {
  id: number;
  connectionId: number;
  name: string;
  nickname: string | null;
  bankProduct: string | null;
  maskedIdentifier: string | null;
  iban: string | null;
  last4: string | null;
  currency: string;
  cashAccountType: string | null;
  status: AccountStatus;
  balance: { amountMinor: number; currency: string; type: string; asOf: number } | null;
  net30d: { inMinor: number; outMinor: number; netMinor: number };
  /**
   * The same 30 local days as `net30d`, one bucket per day (`end = date`, `balanceMinor: null`,
   * zeros on days without transactions): the account row's mini cash-flow strip.
   */
  daily30d: CashFlowBucket[];
  lastSyncedAt: number | null;
  lastSyncError: { code: string | null; at: number } | null;
  rateLimitedUntil: number | null;
  syncInProgress: boolean;
}

export interface ConnectionSummary {
  id: number;
  bankName: string;
  country: string;
  hasLogo: boolean;
  status: ConnectionStatus;
  validUntil: number;
  createdAt: number;
  renewedAt: number | null;
  lastError: { code: string | null; message: string | null; at: number } | null;
  accounts: AccountSummary[];
}

export interface RemovedAccountSummary {
  id: number;
  name: string;
  maskedIdentifier: string | null;
  bankName: string;
  transactionCount: number;
  removedAt: number;
}

export interface ConnectionsResponse {
  connections: ConnectionSummary[];
  removedAccounts: RemovedAccountSummary[];
}

export interface SyncRunItem {
  id: number;
  trigger: SyncTrigger;
  status: SyncRunStatus;
  startedAt: number;
  finishedAt: number | null;
  inserted: number;
  updated: number;
  removed: number;
  errorCode: string | null;
  skipReason: SkipReason | null;
}

export interface AccountDetailResponse {
  account: AccountSummary;
  connection: Omit<ConnectionSummary, "accounts">;
  syncRuns: SyncRunItem[];
  transactionCount: number;
}

/**
 * Body of `PATCH /api/accounts/:accountId`. An empty or blank nickname clears it (`null`); the
 * status can only be switched between `active` and `disabled` by the owner.
 */
export const accountPatchSchema = z
  .object({
    nickname: z
      .string()
      .trim()
      .max(80)
      .transform((value) => (value === "" ? null : value))
      .nullable()
      .optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict();
export type AccountPatch = z.infer<typeof accountPatchSchema>;

export interface BalanceHistoryResponse {
  currency: string;
  points: { date: LocalDate; balanceMinor: number }[];
}

export const balanceHistoryQuerySchema = z.object({
  days: z.coerce
    .number()
    .pipe(z.union([z.literal(30), z.literal(90), z.literal(365)]))
    .default(90),
});
export type BalanceHistoryQuery = z.infer<typeof balanceHistoryQuerySchema>;
