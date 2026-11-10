import type { ReactNode } from "react";
import { Link } from "react-router";
import { buildPath, type RouteId, routeById } from "./routes";

export interface ShippedLinkProps {
  route: RouteId;
  params?: Record<string, string | number>;
  search?: Record<string, string>;
  hash?: string;
  className?: string;
  /** Classes for the plain-text rendering; defaults to `className`. */
  plainClassName?: string;
  /** What to render while the route is not shipped: its text (default) or nothing. */
  whenUnshipped?: "plain" | "hide";
  children: ReactNode;
}

export function isRouteShipped(route: RouteId): boolean {
  return routeById(route).shipped;
}

/**
 * "Hidden until shipped" for links: a link to a page that does not exist yet would be a
 * dead end, so it renders as text (or not at all) until its route is shipped.
 */
export function ShippedLink({
  route,
  params,
  search,
  hash,
  className,
  plainClassName,
  whenUnshipped = "plain",
  children,
}: ShippedLinkProps) {
  if (!isRouteShipped(route)) {
    if (whenUnshipped === "hide") return null;
    return <span className={plainClassName ?? className}>{children}</span>;
  }
  const path = buildPath(route, params, search);
  return (
    <Link to={hash ? `${path}#${hash}` : path} className={className}>
      {children}
    </Link>
  );
}
