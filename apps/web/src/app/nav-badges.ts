import { useMemo } from "react";
import { countNeedingAction } from "../lib/connection-state";
import { useConnectionsQuery } from "../lib/use-connections";
import type { RouteId } from "./routes";

export interface NavBadge {
  count: number;
  tone: "neutral" | "accent";
}

const NO_BADGES: Partial<Record<RouteId, NavBadge>> = Object.freeze({});

/**
 * Sidebar badges by route: neutral for a total, accent for a count that needs action. Accounts
 * gets an accent badge with the number of connections that are expiring, expired, revoked or in
 * error, read from the same `connections` query as the Accounts page.
 */
export function useNavBadges(): Partial<Record<RouteId, NavBadge>> {
  const { data } = useConnectionsQuery();
  return useMemo(() => {
    const count = countNeedingAction(data?.connections ?? []);
    return count > 0 ? { accounts: { count, tone: "accent" as const } } : NO_BADGES;
  }, [data]);
}
