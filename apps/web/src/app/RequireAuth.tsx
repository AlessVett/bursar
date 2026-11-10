import type { AuthStatus } from "@bursar/shared";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { type DataRouter, Navigate, Outlet, useLocation } from "react-router";
import { api } from "../api";
import { Button } from "../components/ui";
import { queryKeys } from "../lib/query-keys";
import { ProductMark } from "./AuthShell";

const AUTH_PATHS = new Set(["/login", "/setup"]);

function hasUnsafeChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || char === "\\") return true;
  }
  return false;
}

/** A same-origin in-app path to return to after sign-in, or `/` for anything else. */
export function safeNext(raw: string | null | undefined): string {
  // URL parsers strip tab/CR/LF ("/\t/host" becomes "//host") and treat "\\" as "/": reject
  // control characters and backslashes anywhere in the value.
  if (!raw?.startsWith("/") || raw.startsWith("//") || hasUnsafeChar(raw)) return "/";
  const pathname = raw.split(/[?#]/, 1)[0] ?? "/";
  return AUTH_PATHS.has(pathname) ? "/" : raw;
}

/** `/login`, with `next` when it is not Home and `expired=1` after a session expiry. */
export function loginPath(next: string, options: { expired?: boolean } = {}): string {
  const search = new URLSearchParams();
  if (options.expired) search.set("expired", "1");
  const target = safeNext(next);
  if (target !== "/") search.set("next", target);
  const query = search.toString();
  return query ? `/login?${query}` : "/login";
}

/**
 * Called by the query client on a 401: marks the session as gone in the cache (so the login page
 * does not bounce back) and sends the owner to the login page with the expiry notice.
 */
export function expireSession(router: DataRouter, queryClient: QueryClient): void {
  const { pathname, search } = router.state.location;
  if (AUTH_PATHS.has(pathname)) return;
  queryClient.setQueryData<AuthStatus>(queryKeys.authStatus, {
    setupRequired: false,
    authenticated: false,
  });
  void router.navigate(loginPath(`${pathname}${search}`, { expired: true }), { replace: true });
}

function FullPageStatus({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="grid min-h-dvh place-items-center bg-bg px-4"
      aria-busy={failed ? undefined : "true"}
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <ProductMark size="lg" />
        {failed ? (
          <>
            <p role="alert" className="max-w-sm text-sm text-fg">
              {t("common.serverUnavailable")}
            </p>
            <Button variant="secondary" onClick={onRetry}>
              {t("shell.retry")}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted">{t("common.loading")}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Route guard for both areas. `app`: setup first, then sign-in (with `next`). `auth`: `/setup` only
 * while setup is required, `/login` only while signed out; a signed-in owner goes to `next`.
 *
 * The full-page status shows only while no status is known. A background refetch that fails (the
 * live stream invalidates the status on every error, for example during a server restart) keeps
 * routing on the last known status, so the shell, its open forms and the stream's reconnects stay.
 */
export function RequireAuth({ area }: { area: "app" | "auth" }) {
  const location = useLocation();
  const status = useQuery({ queryKey: queryKeys.authStatus, queryFn: api.status });

  if (status.data === undefined) {
    return <FullPageStatus failed={status.isError} onRetry={() => void status.refetch()} />;
  }

  const { setupRequired, authenticated } = status.data;
  const here = `${location.pathname}${location.search}`;

  if (area === "app") {
    if (setupRequired) return <Navigate to="/setup" replace />;
    if (!authenticated) return <Navigate to={loginPath(here)} replace />;
    return <Outlet />;
  }

  if (setupRequired) {
    return location.pathname === "/setup" ? <Outlet /> : <Navigate to="/setup" replace />;
  }
  if (authenticated) {
    const next = new URLSearchParams(location.search).get("next");
    return <Navigate to={safeNext(next)} replace />;
  }
  if (location.pathname === "/setup") {
    return <Navigate to={`/login${location.search}`} replace />;
  }
  return <Outlet />;
}
