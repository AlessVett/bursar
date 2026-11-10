import {
  Activity,
  ArrowLeftRight,
  Bot,
  ChartColumn,
  FileText,
  House,
  Landmark,
  Link as LinkIcon,
  type LucideIcon,
  MessagesSquare,
  Settings,
  Wallet,
} from "lucide-react";

export type RouteId =
  | "home"
  | "accounts"
  | "account"
  | "connect"
  | "connectCallback"
  | "transactions"
  | "settings"
  | "documents"
  | "reports"
  | "chat"
  | "agents"
  | "activity";

export type NavGroup = "top" | "money" | "knowledge" | "agents" | "bottom";

export interface RouteDef {
  id: RouteId;
  path: string;
  titleKey: string;
  descriptionKey: string;
  keywordsKey: string;
  icon: LucideIcon;
  group: NavGroup | null;
  parent: RouteId | null;
  shipped: boolean;
}

/** Sidebar order of the navigation groups (UX doc §2). */
export const NAV_GROUPS: readonly NavGroup[] = ["top", "money", "knowledge", "agents", "bottom"];

function route(
  id: RouteId,
  path: string,
  icon: LucideIcon,
  group: NavGroup | null,
  parent: RouteId | null,
  shipped: boolean,
): RouteDef {
  return {
    id,
    path,
    titleKey: `routes.${id}.title`,
    descriptionKey: `routes.${id}.description`,
    keywordsKey: `routes.${id}.keywords`,
    icon,
    group,
    parent,
    shipped,
  };
}

/**
 * The single source of truth for the panel's pages: the router, the sidebar, the topbar title, the
 * breadcrumbs and the command palette all read it. A page task flips `shipped` to true when its page
 * exists; until then the route is invisible everywhere (hidden until shipped).
 */
export const ROUTES: readonly RouteDef[] = [
  route("home", "/", House, "top", null, true),
  route("accounts", "/accounts", Landmark, "money", null, false),
  route("account", "/accounts/:accountId", Wallet, null, "accounts", false),
  route("connect", "/connect", LinkIcon, null, "accounts", false),
  route("connectCallback", "/connect/callback", LinkIcon, null, "accounts", false),
  route("transactions", "/transactions", ArrowLeftRight, "money", null, false),
  route("documents", "/documents", FileText, "knowledge", null, false),
  route("reports", "/reports", ChartColumn, "knowledge", null, false),
  route("chat", "/chat", MessagesSquare, "agents", null, false),
  route("agents", "/agents", Bot, "agents", null, false),
  route("activity", "/activity", Activity, "agents", null, false),
  route("settings", "/settings", Settings, "bottom", null, false),
];

export function shippedRoutes(): RouteDef[] {
  return ROUTES.filter((def) => def.shipped);
}

export function routeById(id: RouteId): RouteDef {
  const def = ROUTES.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`Unknown route id: ${id}`);
  return def;
}

function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Resolves a pathname to a route. When several routes match, the one with the most fixed (non-param)
 * segments wins (`/connect/callback` is `connectCallback`, `/accounts/12` is `account`). Only the
 * given routes are considered: shipped routes by default.
 */
export function matchRoute(
  pathname: string,
  routes: readonly RouteDef[] = shippedRoutes(),
): { route: RouteDef; params: Record<string, string> } | null {
  const actual = segments(pathname);
  let best: { route: RouteDef; params: Record<string, string>; fixed: number } | null = null;
  for (const def of routes) {
    const pattern = segments(def.path);
    if (pattern.length !== actual.length) continue;
    const params: Record<string, string> = {};
    let fixed = 0;
    let matches = true;
    for (const [index, part] of pattern.entries()) {
      const value = decodeSegment(actual[index] ?? "");
      if (value === null) {
        matches = false;
        break;
      }
      if (part.startsWith(":")) {
        params[part.slice(1)] = value;
      } else if (part === value) {
        fixed += 1;
      } else {
        matches = false;
        break;
      }
    }
    if (matches && (best === null || fixed > best.fixed)) best = { route: def, params, fixed };
  }
  return best ? { route: best.route, params: best.params } : null;
}

/** Ancestors from the top down, ending with the route itself (registry order, shipped or not). */
export function breadcrumbTrail(id: RouteId): RouteDef[] {
  const trail: RouteDef[] = [];
  const seen = new Set<RouteId>();
  let current: RouteDef | null = routeById(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    current = current.parent ? routeById(current.parent) : null;
  }
  return trail;
}

/**
 * Builds a path for a route: `:name` segments are filled from `params` (URL-encoded) and `search`
 * entries with an empty value are left out, matching the URL-state rule that defaults are absent.
 */
export function buildPath(
  id: RouteId,
  params: Record<string, string | number> = {},
  search: Record<string, string> = {},
): string {
  const path = segments(routeById(id).path)
    .map((part) => {
      if (!part.startsWith(":")) return part;
      const value = params[part.slice(1)];
      if (value === undefined || value === "") {
        throw new Error(`Missing route parameter ${part.slice(1)} for ${id}`);
      }
      return encodeURIComponent(String(value));
    })
    .join("/");
  const query = new URLSearchParams(
    Object.entries(search).filter(([, value]) => value.length > 0),
  ).toString();
  return `/${path}${query ? `?${query}` : ""}`;
}
