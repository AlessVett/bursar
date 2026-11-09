import type {
  AuthStatus,
  LoginRequest,
  SetupConfirmRequest,
  SetupStartRequest,
  SetupStartResponse,
} from "@bursar/shared";

export const AUTH_STATUS_KEY = ["auth-status"] as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
        ? data.error
        : response.statusText;
    throw new ApiError(response.status, message);
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
};
