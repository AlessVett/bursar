import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./query-keys";

/**
 * The connections and their accounts. One key shared by the Accounts page, the sidebar badge and
 * the command palette, so they always agree; live events invalidate it (Task 17).
 */
export function useConnectionsQuery(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections(),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}

/**
 * Everything that shows an account's name, status, balance or transactions. Called after any
 * change to an account or a connection.
 */
export async function invalidateAccountData(client: QueryClient): Promise<void> {
  await Promise.all(
    [queryKeys.connections, queryKeys.summary, ["accounts"], ["transactions"], ["cashflow"]].map(
      (queryKey) => client.invalidateQueries({ queryKey }),
    ),
  );
}
