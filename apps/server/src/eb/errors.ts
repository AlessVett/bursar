export type EbErrorKind = "reauth" | "account" | "rate_limited" | "retry" | "fatal";

const REAUTH_CODES = new Set([
  "EXPIRED_SESSION",
  "CLOSED_SESSION",
  "REVOKED_SESSION",
  "SESSION_DOES_NOT_EXIST",
  "WRONG_SESSION_STATUS",
]);
const ACCOUNT_CODES = new Set(["ACCOUNT_DOES_NOT_EXIST", "ASPSP_ACCOUNT_NOT_ACCESSIBLE"]);
const RETRY_CODES = new Set(["ASPSP_ERROR", "ASPSP_TIMEOUT"]);
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Provider messages are cut to this length before they reach an error message. */
export const EB_MESSAGE_MAX_LENGTH = 200;
const DETAIL_MAX_LENGTH = 500;

/**
 * Maps an Enable Banking failure to what Bursar does next (eb-api-notes.md §9). Logic keys on the
 * `error` code first because the same HTTP status can mean different things. Status 0 means the
 * request never got an HTTP answer (network failure or timeout).
 */
export function classifyEbError(status: number, code: string | null): EbErrorKind {
  if (code && REAUTH_CODES.has(code)) return "reauth";
  if (code && ACCOUNT_CODES.has(code)) return "account";
  if (code === "ASPSP_RATE_LIMIT_EXCEEDED" || status === 429) return "rate_limited";
  if ((code && RETRY_CODES.has(code)) || status === 0 || status === 408 || status >= 500) {
    return "retry";
  }
  return "fatal";
}

/**
 * The message holds only the HTTP status, the Enable Banking error code and the API's own message:
 * never request data, headers, tokens or the rest of the response body.
 */
export class EnableBankingError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: string | null;
  readonly kind: EbErrorKind;

  constructor(status: number, code: string | null, message: string, detail: string | null = null) {
    const apiMessage = message.slice(0, EB_MESSAGE_MAX_LENGTH);
    super(`Enable Banking error ${status}${code ? ` ${code}` : ""}: ${apiMessage}`);
    this.name = "EnableBankingError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.kind = classifyEbError(status, code);
  }
}

export function parseEbErrorBody(status: number, body: unknown): EnableBankingError {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const code =
    typeof record.error === "string" && ERROR_CODE_PATTERN.test(record.error) ? record.error : null;
  const message =
    typeof record.message === "string" && record.message.trim() !== ""
      ? record.message.trim()
      : "Unexpected response";
  const detail =
    typeof record.detail === "string" ? record.detail.slice(0, DETAIL_MAX_LENGTH) : null;
  return new EnableBankingError(status, code, message, detail);
}
