import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api";

const ACCESS_ERROR_PREFIXES = [
  "Missing Cloudflare Access token",
  "Invalid Cloudflare Access token",
];

/** A 401 from an API route outside `/api/auth/*`: the session cookie expired or was revoked. */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && !error.path.startsWith("/api/auth/");
}

/**
 * A 403 from Cloudflare Access (its JSON messages, or the HTML page Access serves at the edge),
 * as opposed to Bursar's own JSON 403s such as the Origin check.
 */
export function isAccessDenied(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  if (!error.isJson) return true;
  return ACCESS_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix));
}

export interface QueryClientHandlers {
  onUnauthorized(): void;
  onAccessDenied(): void;
}

export function createQueryClient(handlers: QueryClientHandlers): QueryClient {
  const onError = (error: unknown) => {
    if (isSessionExpired(error)) handlers.onUnauthorized();
    else if (isAccessDenied(error)) handlers.onAccessDenied();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
