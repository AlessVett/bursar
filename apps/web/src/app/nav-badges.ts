import type { RouteId } from "./routes";

export interface NavBadge {
  count: number;
  tone: "neutral" | "accent";
}

const NO_BADGES: Partial<Record<RouteId, NavBadge>> = Object.freeze({});

/**
 * Sidebar badges by route: neutral for a total, accent for a count that needs action. Nothing in this
 * task has a count yet; Task 18 adds the accounts badge from the connections query.
 */
export function useNavBadges(): Partial<Record<RouteId, NavBadge>> {
  return NO_BADGES;
}
