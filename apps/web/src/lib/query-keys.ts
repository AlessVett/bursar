/**
 * Every TanStack Query key used by the panel. Pages and live updates import keys from here so an
 * invalidation always reaches the queries it means to.
 */
export const queryKeys = {
  authStatus: ["auth-status"],
  settings: ["settings"],
  bankStatus: ["banks", "status"],
  aspsps: (country: string) => ["banks", "aspsps", country],
  connections: ["connections"],
  account: (id: number) => ["accounts", id],
  balanceHistory: (id: number, days: number) => ["accounts", id, "balance-history", days],
  summary: ["summary"],
  cashflow: (params: Record<string, string>) => ["cashflow", params],
  transactions: (params: Record<string, string>) => ["transactions", "list", params],
  transaction: (id: number) => ["transactions", "detail", id],
  search: (q: string) => ["search", q],
  notifications: ["notifications"],
  backups: ["backups"],
} as const;
