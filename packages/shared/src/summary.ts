import type { AccountSummary } from "./accounts";
import type { CashFlowResponse } from "./transactions";

export type HomeAlert =
  | { kind: "consent_expiring"; connectionId: number; bankName: string; days: number }
  | { kind: "consent_expired" | "connection_error"; connectionId: number; bankName: string }
  | { kind: "sync_failing"; accountId: number; accountName: string; since: number | null }
  | { kind: "rate_limited"; accountId: number; accountName: string; until: number }
  | { kind: "backup_local_only" }
  | { kind: "backup_failing"; failures: number };

export interface HomeSummary {
  generatedAt: number;
  balances: { currency: string; amountMinor: number; accountCount: number }[];
  cashflow30d: CashFlowResponse | null;
  accounts: AccountSummary[];
  alerts: HomeAlert[];
  hasConnections: boolean;
}
