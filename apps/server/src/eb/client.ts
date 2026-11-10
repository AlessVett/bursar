import type { LocalDate } from "@bursar/shared";
import type { z } from "zod";
import { assertAllowed } from "./allowlist";
import { EnableBankingError, parseEbErrorBody } from "./errors";
import { createJwtSigner } from "./jwt";
import {
  type EbApplication,
  type EbAspsp,
  type EbBalance,
  type EbSession,
  type EbSessionStatus,
  type EbStartAuthorizationRequest,
  type EbStartAuthorizationResponse,
  type EbTransaction,
  type EbTransactionsPage,
  ebApplicationSchema,
  ebAspspListSchema,
  ebBalanceSchema,
  ebBalancesResponseSchema,
  ebSessionSchema,
  ebSessionStatusSchema,
  ebStartAuthorizationResponseSchema,
  ebTransactionSchema,
  ebTransactionsPageEnvelopeSchema,
} from "./schemas";

export const EB_DEFAULT_BASE_URL = "https://api.enablebanking.com";
export const EB_DEFAULT_TIMEOUT_MS = 30_000;
const PSU_HEADER_MAX_LENGTH = 512;

/** Present only when the owner triggered the fetch from the panel (eb-api-notes.md §8). */
export interface PsuHeaders {
  ipAddress: string;
  userAgent: string;
  accept?: string;
  acceptLanguage?: string;
}

export interface TransactionsQuery {
  dateFrom?: LocalDate;
  dateTo?: LocalDate;
  strategy?: "default" | "longest";
  continuationKey?: string;
}

export interface EnableBankingApi {
  getApplication(): Promise<EbApplication>;
  listAspsps(country: string): Promise<EbAspsp[]>;
  startAuthorization(request: EbStartAuthorizationRequest): Promise<EbStartAuthorizationResponse>;
  createSession(code: string): Promise<EbSession>;
  getSession(sessionId: string): Promise<EbSessionStatus>;
  deleteSession(sessionId: string): Promise<void>;
  getBalances(accountUid: string, psu?: PsuHeaders): Promise<EbBalance[]>;
  getTransactions(
    accountUid: string,
    query: TransactionsQuery,
    psu?: PsuHeaders,
  ): Promise<EbTransactionsPage>;
}

type Method = "GET" | "POST" | "DELETE";

interface CallOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  psu?: PsuHeaders;
}

interface CallResult {
  status: number;
  data: unknown;
}

function headerValue(value: string): string {
  // Control characters would make fetch throw; the bank needs a single printable line.
  let clean = "";
  for (const char of value.slice(0, PSU_HEADER_MAX_LENGTH)) {
    const code = char.charCodeAt(0);
    clean += code < 0x20 || code === 0x7f ? " " : char;
  }
  return clean;
}

function psuHeaders(psu: PsuHeaders): Record<string, string> {
  const headers: Record<string, string> = {
    "Psu-Ip-Address": headerValue(psu.ipAddress),
    "Psu-User-Agent": headerValue(psu.userAgent),
  };
  if (psu.accept) headers["Psu-Accept"] = headerValue(psu.accept);
  if (psu.acceptLanguage) headers["Psu-Accept-Language"] = headerValue(psu.acceptLanguage);
  return headers;
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function transportError(error: unknown): EnableBankingError {
  // The original error can contain the URL or socket details: keep only the category.
  return new EnableBankingError(0, null, isTimeout(error) ? "Request timed out" : "Network error");
}

function validate<S extends z.ZodType>(schema: S, result: CallResult): z.output<S> {
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    throw new EnableBankingError(result.status, null, "Unexpected response from Enable Banking");
  }
  return parsed.data;
}

/**
 * Read-only Enable Banking client. Every request goes through the private `call`, which checks the
 * allowlist first. The prototype carries exactly the eight `EnableBankingApi` methods.
 */
export class EnableBankingClient implements EnableBankingApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signer: { token(): Promise<string> };

  constructor(options: {
    applicationId: string;
    privateKeyPem: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
  }) {
    const base = new URL(options.baseUrl ?? EB_DEFAULT_BASE_URL);
    if (base.protocol !== "https:") {
      throw new Error("The Enable Banking API base URL must use https");
    }
    this.baseUrl = base.href.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? EB_DEFAULT_TIMEOUT_MS;
    this.signer = createJwtSigner({
      applicationId: options.applicationId,
      privateKeyPem: options.privateKeyPem,
      now: options.now,
    });
  }

  async getApplication(): Promise<EbApplication> {
    return validate(ebApplicationSchema, await this.call("GET", "/application"));
  }

  async listAspsps(country: string): Promise<EbAspsp[]> {
    const result = await this.call("GET", "/aspsps", {
      query: { country, psu_type: "personal", service: "AIS" },
    });
    return validate(ebAspspListSchema, result).aspsps;
  }

  async startAuthorization(
    request: EbStartAuthorizationRequest,
  ): Promise<EbStartAuthorizationResponse> {
    const result = await this.call("POST", "/auth", { body: request });
    return validate(ebStartAuthorizationResponseSchema, result);
  }

  async createSession(code: string): Promise<EbSession> {
    return validate(ebSessionSchema, await this.call("POST", "/sessions", { body: { code } }));
  }

  async getSession(sessionId: string): Promise<EbSessionStatus> {
    return validate(ebSessionStatusSchema, await this.call("GET", `/sessions/${sessionId}`));
  }

  async deleteSession(sessionId: string): Promise<void> {
    // The body is a free-form `{ message }`; only the status matters.
    await this.call("DELETE", `/sessions/${sessionId}`);
  }

  /** Balances that match `ebBalanceSchema`; a malformed item is dropped, never the response. */
  async getBalances(accountUid: string, psu?: PsuHeaders): Promise<EbBalance[]> {
    const result = await this.call("GET", `/accounts/${accountUid}/balances`, { psu });
    const balances: EbBalance[] = [];
    for (const item of validate(ebBalancesResponseSchema, result).balances) {
      const parsed = ebBalanceSchema.safeParse(item);
      if (parsed.success) balances.push(parsed.data);
    }
    return balances;
  }

  async getTransactions(
    accountUid: string,
    query: TransactionsQuery,
    psu?: PsuHeaders,
  ): Promise<EbTransactionsPage> {
    const result = await this.call("GET", `/accounts/${accountUid}/transactions`, {
      query: {
        date_from: query.dateFrom,
        date_to: query.dateTo,
        strategy: query.strategy,
        continuation_key: query.continuationKey,
      },
      psu,
    });
    const page = validate(ebTransactionsPageEnvelopeSchema, result);
    const transactions: EbTransaction[] = [];
    for (const item of page.transactions) {
      const parsed = ebTransactionSchema.safeParse(item);
      if (parsed.success) transactions.push(parsed.data);
    }
    return {
      transactions,
      continuation_key: page.continuation_key,
      skipped: page.transactions.length - transactions.length,
    };
  }

  /**
   * The single network path. An instance property (not a prototype method) so the class prototype
   * holds only the API methods. The allowlist check is the first statement.
   */
  private readonly call = async (
    method: Method,
    path: string,
    options: CallOptions = {},
  ): Promise<CallResult> => {
    assertAllowed(method, path);
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${await this.signer.token()}`,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.psu) Object.assign(headers, psuHeaders(options.psu));

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url.href, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw transportError(error);
    }

    let data: unknown;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      data = undefined;
    }
    if (!response.ok) throw parseEbErrorBody(response.status, data);
    return { status: response.status, data };
  };
}
