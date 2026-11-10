import type {
  AccountDetailResponse,
  AccountPatch,
  AccountSummary,
  AuthStatus,
  BalanceHistoryResponse,
  CashFlowResponse,
  ConnectionsResponse,
  DisconnectResponse,
  HomeSummary,
  LoginRequest,
  PurgeResponse,
  RemovalPreview,
  RenewConnectionRequest,
  SettingsResponse,
  SetupConfirmRequest,
  SetupStartRequest,
  SetupStartResponse,
  StartConnectionResponse,
  SyncQueuedResponse,
  TransactionListResponse,
} from "@bursar/shared";
import { queryKeys } from "./lib/query-keys";

/** Kept for the M0 call sites; new code uses `queryKeys.authStatus`. */
export const AUTH_STATUS_KEY = queryKeys.authStatus;

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiErrorDetails {
  code?: string | null;
  retryAt?: number | null;
  path?: string;
  isJson?: boolean;
}

/**
 * A non-2xx response from the API. `message` is the server's English `error`, `code` its stable
 * snake_case code (translated by the UI), `retryAt` an epoch-ms hint for rate limits. `isJson` is
 * false when the body was not a JSON object (for example an HTML page from Cloudflare Access).
 */
export class ApiError extends Error {
  readonly code: string | null;
  readonly retryAt: number | null;
  readonly path: string;
  readonly isJson: boolean;

  constructor(
    readonly status: number,
    message: string,
    details: ApiErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = details.code ?? null;
    this.retryAt = details.retryAt ?? null;
    this.path = details.path ?? "";
    this.isJson = details.isJson ?? false;
  }
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Calls the API with the session cookie. Resolves with the parsed JSON body (`undefined` for 204)
 * and rejects with `ApiError` for any non-2xx status or a 2xx body that is not JSON.
 */
export async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text().catch(() => "");
  const data = parseJson(text);
  if (!response.ok) {
    const object = asObject(data);
    const message = typeof object?.error === "string" ? object.error : response.statusText;
    throw new ApiError(response.status, message, {
      code: typeof object?.code === "string" ? object.code : null,
      retryAt: typeof object?.retryAt === "number" ? object.retryAt : null,
      path,
      isJson: object !== null,
    });
  }
  if (data === undefined) {
    throw new ApiError(response.status, "Invalid JSON response", { path, isJson: false });
  }
  return data as T;
}

export const api = {
  status: () => request<AuthStatus>("GET", "/api/auth/status"),
  setupStart: (body: SetupStartRequest) =>
    request<SetupStartResponse>("POST", "/api/auth/setup/start", body),
  setupConfirm: (body: SetupConfirmRequest) =>
    request<{ ok: true }>("POST", "/api/auth/setup/confirm", body),
  login: (body: LoginRequest) => request<{ ok: true }>("POST", "/api/auth/login", body),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  connections: () => request<ConnectionsResponse>("GET", "/api/connections"),
  updateAccount: (id: number, patch: AccountPatch) =>
    request<AccountSummary>("PATCH", `/api/accounts/${id}`, patch),
  syncAccount: (id: number) => request<SyncQueuedResponse>("POST", `/api/accounts/${id}/sync`),
  syncConnection: (id: number) =>
    request<SyncQueuedResponse>("POST", `/api/connections/${id}/sync`),
  renewConnection: (id: number, body: RenewConnectionRequest = {}) =>
    request<StartConnectionResponse>("POST", `/api/connections/${id}/renew`, body),
  removalPreview: (id: number) =>
    request<RemovalPreview>("GET", `/api/connections/${id}/removal-preview`),
  disconnect: (id: number) => request<DisconnectResponse>("DELETE", `/api/connections/${id}`),
  purgeAccount: (id: number) =>
    request<PurgeResponse>("POST", `/api/accounts/${id}/purge`, { confirm: true }),
  summary: () => request<HomeSummary>("GET", "/api/summary"),
  settings: () => request<SettingsResponse>("GET", "/api/settings"),
  /** 204 (no data for the filters) becomes `null`. Task 19 reuses this function. */
  cashflow: async (params: {
    accountId?: number;
    from?: string;
    to?: string;
    currency?: string;
  }): Promise<CashFlowResponse | null> => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const query = search.toString();
    const data = await request<CashFlowResponse | undefined>(
      "GET",
      query ? `/api/cashflow?${query}` : "/api/cashflow",
    );
    return data ?? null;
  },
  account: (id: number) => request<AccountDetailResponse>("GET", `/api/accounts/${id}`),
  balanceHistory: (id: number, days: 30 | 90 | 365) =>
    request<BalanceHistoryResponse>("GET", `/api/accounts/${id}/balance-history?days=${days}`),
  /** Task 21 reuses this for the full list: `params` are the query-string fields of the API. */
  transactions: (params: Record<string, string>) =>
    request<TransactionListResponse>("GET", `/api/transactions?${new URLSearchParams(params)}`),
};

/**
 * Same-origin URL of a bank logo. The server proxies the image (the CSP allows only `'self'`
 * images) and looks the logo up by ASPSP, so no external URL ever reaches the browser.
 */
export function bankLogoUrl(country: string, name: string): string {
  return `/api/banks/logo?${new URLSearchParams({ country, name }).toString()}`;
}
