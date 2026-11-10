import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { EnableBankingClient, type PsuHeaders } from "./client";
import { EnableBankingError } from "./errors";
import application from "./fixtures/application.json";
import aspsps from "./fixtures/aspsps.json";
import auth from "./fixtures/auth.json";
import balances from "./fixtures/balances.json";
import expiredSession from "./fixtures/error-expired-session.json";
import psuHeader from "./fixtures/error-psu-header.json";
import rateLimit from "./fixtures/error-rate-limit.json";
import session from "./fixtures/session.json";
import sessionEmpty from "./fixtures/session-empty.json";
import sessionStatus from "./fixtures/session-status.json";
import transactionsPage1 from "./fixtures/transactions-page-1.json";
import transactionsPage2 from "./fixtures/transactions-page-2.json";

const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PUBLIC_KEY = createPublicKey(keys.publicKey);
const APPLICATION_ID = application.kid;
const NOW_MS = Date.UTC(2026, 10, 9, 9, 0, 0);
const SESSION_ID = "2820b3c9-d6b3-45f5-bcd2-a13b759976ca";
const ACCOUNT_UID = "3be3331e-a556-4a75-a5df-c08a2c064878";
const PSU: PsuHeaders = {
  ipAddress: "203.0.113.7",
  userAgent: "Mozilla/5.0 (fixture browser)",
  accept: "text/html",
  acceptLanguage: "it-IT",
};

interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
}

function replying(...replies: Reply[]) {
  const queue = [...replies];
  return vi.fn<typeof fetch>(async () => {
    const reply = queue.shift() ?? { status: 500, body: { message: "Unexpected call" } };
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function clientWith(fetchImpl: typeof fetch, extra: { timeoutMs?: number; baseUrl?: string } = {}) {
  return new EnableBankingClient({
    applicationId: APPLICATION_ID,
    privateKeyPem: keys.privateKey,
    fetch: fetchImpl,
    now: () => NOW_MS,
    ...extra,
  });
}

function sent(spy: ReturnType<typeof replying>, index = 0) {
  const call = spy.mock.calls[index];
  if (!call) throw new Error(`fetch call ${index} is missing`);
  const [input, init] = call;
  return {
    url: new URL(String(input)),
    init,
    method: init?.method,
    headers: new Headers(init?.headers),
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  };
}

function psuHeaderNames(headers: Headers): string[] {
  return [...headers.keys()].filter((name) => name.startsWith("psu-")).sort();
}

async function rejection(promise: Promise<unknown>): Promise<EnableBankingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EnableBankingError) return error;
    throw error;
  }
  throw new Error("Expected an EnableBankingError");
}

describe("EnableBankingClient", () => {
  it("getApplication sends a signed bearer token and no redirects", async () => {
    const spy = replying({ body: application });
    const result = await clientWith(spy).getApplication();
    expect(result.environment).toBe("SANDBOX");
    expect(result.redirect_urls).toContain("https://bursar.example.test/api/banks/callback");

    const request = sent(spy);
    expect(request.url.href).toBe("https://api.enablebanking.com/application");
    expect(request.method).toBe("GET");
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.headers.has("content-type")).toBe(false);
    expect(request.init?.redirect).toBe("error");
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);

    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const { protectedHeader, payload } = await jwtVerify(token, PUBLIC_KEY, {
      issuer: "enablebanking.com",
      audience: "api.enablebanking.com",
      currentDate: new Date(NOW_MS),
    });
    expect(protectedHeader.kid).toBe(APPLICATION_ID);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(3600);
  });

  it("listAspsps asks for personal account-information banks of one country", async () => {
    const spy = replying({ body: aspsps });
    const result = await clientWith(spy).listAspsps("IT");
    expect(result).toHaveLength(4);
    expect(result[0]?.maximum_consent_validity).toBe(15_552_000);
    expect(result[1]?.bic).toBeNull();

    const request = sent(spy);
    expect(request.url.pathname).toBe("/aspsps");
    expect(Object.fromEntries(request.url.searchParams)).toEqual({
      country: "IT",
      psu_type: "personal",
      service: "AIS",
    });
    expect(psuHeaderNames(request.headers)).toEqual([]);
  });

  it("startAuthorization posts the request body", async () => {
    const spy = replying({ body: auth });
    const body = {
      access: { valid_until: "2027-05-08T09:50:00.000000+00:00" },
      aspsp: { name: "Northwind Bank", country: "IT" },
      state: "state-0123456789abcdef",
      redirect_url: "https://bursar.example.test/api/banks/callback",
      psu_type: "personal" as const,
      language: "it",
    };
    const result = await clientWith(spy).startAuthorization(body);
    expect(result.authorization_id).toBe("046d546a-9293-472a-82df-587c06743100");
    expect(result.url).toMatch(/^https:\/\/auth\.enablebanking\.com\/ais\/start/);

    const request = sent(spy);
    expect([request.method, request.url.pathname]).toEqual(["POST", "/auth"]);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.body).toEqual(body);
  });

  it("createSession exchanges the code for a session with accounts", async () => {
    const spy = replying({ body: session });
    const result = await clientWith(spy).createSession("fixture-code");
    expect(result.session_id).toBe(SESSION_ID);
    expect(result.accounts).toHaveLength(3);
    expect(result.accounts[0]?.uid).toBe(ACCOUNT_UID);
    expect(result.accounts[0]?.identification_hashes).toHaveLength(2);
    expect(result.accounts[2]?.uid ?? null).toBeNull();
    expect(result.access.valid_until).toBe("2027-05-08T09:50:00.000000+00:00");

    const request = sent(spy);
    expect([request.method, request.url.pathname]).toEqual(["POST", "/sessions"]);
    expect(request.body).toEqual({ code: "fixture-code" });
  });

  it("createSession accepts an empty account list (restricted mode)", async () => {
    const result = await clientWith(replying({ body: sessionEmpty })).createSession("code");
    expect(result.accounts).toEqual([]);
  });

  it("getSession and deleteSession address the session by id", async () => {
    const spy = replying({ body: sessionStatus }, { body: { message: "Session closed" } });
    const client = clientWith(spy);
    const status = await client.getSession(SESSION_ID);
    expect(status.status).toBe("AUTHORIZED");
    expect(status.accounts).toHaveLength(2);
    await expect(client.deleteSession(SESSION_ID)).resolves.toBeUndefined();

    expect([sent(spy, 0).method, sent(spy, 0).url.pathname]).toEqual([
      "GET",
      `/sessions/${SESSION_ID}`,
    ]);
    const deletion = sent(spy, 1);
    expect([deletion.method, deletion.url.pathname]).toEqual(["DELETE", `/sessions/${SESSION_ID}`]);
    expect(psuHeaderNames(deletion.headers)).toEqual([]);
  });

  it("getBalances sends PSU headers only when they are given", async () => {
    const spy = replying({ body: balances }, { body: balances });
    const client = clientWith(spy);
    const background = await client.getBalances(ACCOUNT_UID);
    expect(background.map((balance) => balance.balance_type)).toEqual(["CLBD", "ITAV", "XPCD"]);
    expect(background[2]?.balance_amount.amount).toBe("-35.10");
    expect(psuHeaderNames(sent(spy, 0).headers)).toEqual([]);

    await client.getBalances(ACCOUNT_UID, PSU);
    const attended = sent(spy, 1);
    expect(attended.url.pathname).toBe(`/accounts/${ACCOUNT_UID}/balances`);
    expect(attended.headers.get("psu-ip-address")).toBe("203.0.113.7");
    expect(attended.headers.get("psu-user-agent")).toBe("Mozilla/5.0 (fixture browser)");
    expect(attended.headers.get("psu-accept")).toBe("text/html");
    expect(attended.headers.get("psu-accept-language")).toBe("it-IT");
  });

  it("getTransactions passes the window and follows continuation keys", async () => {
    const spy = replying({ body: transactionsPage1 }, { body: transactionsPage2 });
    const client = clientWith(spy);
    const first = await client.getTransactions(
      ACCOUNT_UID,
      { dateFrom: "2026-08-01", dateTo: "2026-11-09", strategy: "default" },
      PSU,
    );
    expect(first.transactions).toHaveLength(3);
    expect(first.transactions[0]?.status).toBe("PDNG");
    expect(first.transactions[0]?.booking_date).toBeNull();
    expect(first.transactions[1]?.remittance_information).toEqual([
      "Invoice 2026-10 electricity",
      "Customer ref 00123",
    ]);
    expect(first.continuation_key).toBe("next-page-2");
    const firstRequest = sent(spy, 0);
    expect(firstRequest.url.pathname).toBe(`/accounts/${ACCOUNT_UID}/transactions`);
    expect(Object.fromEntries(firstRequest.url.searchParams)).toEqual({
      date_from: "2026-08-01",
      date_to: "2026-11-09",
      strategy: "default",
    });
    expect(firstRequest.headers.get("psu-ip-address")).toBe("203.0.113.7");

    const second = await client.getTransactions(ACCOUNT_UID, {
      continuationKey: first.continuation_key ?? "",
    });
    expect(second.continuation_key).toBeNull();
    expect(Object.fromEntries(sent(spy, 1).url.searchParams)).toEqual({
      continuation_key: "next-page-2",
    });
    expect(psuHeaderNames(sent(spy, 1).headers)).toEqual([]);
  });

  it("drops a transaction item that does not match the schema and counts it", async () => {
    const [valid] = transactionsPage1.transactions;
    const deviating = { ...valid, credit_debit_indicator: "XXXX" };
    const page = await clientWith(
      replying({ body: { transactions: [valid, deviating], continuation_key: null } }),
    ).getTransactions(ACCOUNT_UID, {});
    expect(page.transactions).toHaveLength(1);
    expect(page.skipped).toBe(1);
    expect(page.continuation_key).toBeNull();
  });

  it("rejects a response that does not match the documented shape", async () => {
    const error = await rejection(
      clientWith(replying({ body: { transactions: "nope-0001" } })).getTransactions(
        ACCOUNT_UID,
        {},
      ),
    );
    expect(error.kind).toBe("fatal");
    expect(error.message).not.toContain("nope-0001");
  });

  const ERROR_CASES: [string, Reply, string, string | null][] = [
    ["an expired session", { status: 401, body: expiredSession }, "reauth", "EXPIRED_SESSION"],
    [
      "the bank rate limit",
      { status: 429, body: rateLimit },
      "rate_limited",
      "ASPSP_RATE_LIMIT_EXCEEDED",
    ],
    ["a missing PSU header", { status: 422, body: psuHeader }, "fatal", "PSU_HEADER_NOT_PROVIDED"],
    [
      "a body without an error code",
      { status: 400, body: { message: "Bad request" } },
      "fatal",
      null,
    ],
    ["a non-JSON gateway error", { status: 502, text: "<html>Bad gateway</html>" }, "retry", null],
    [
      "a bank-side failure",
      { status: 500, body: { message: "Bank unavailable", code: 500, error: "ASPSP_ERROR" } },
      "retry",
      "ASPSP_ERROR",
    ],
  ];

  it.each(ERROR_CASES)("maps %s to an EnableBankingError", async (_label, reply, kind, code) => {
    const spy = replying(reply);
    const error = await rejection(clientWith(spy).getBalances(ACCOUNT_UID));
    expect(error.status).toBe(reply.status);
    expect(error.kind).toBe(kind);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain("<html>");
    const token = (sent(spy).headers.get("authorization") ?? "").replace(/^Bearer /, "");
    expect(error.message).not.toContain(token);
  });

  it("maps a network failure to a retryable error", async () => {
    const failing = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 192.0.2.1:443");
    });
    const error = await rejection(clientWith(failing).getBalances(ACCOUNT_UID));
    expect([error.status, error.code, error.kind]).toEqual([0, null, "retry"]);
    expect(error.message).toBe("Enable Banking error 0: Network error");
  });

  it("maps a timeout to a retryable error", async () => {
    const hanging = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const error = await rejection(clientWith(hanging, { timeoutMs: 20 }).getBalances(ACCOUNT_UID));
    expect([error.status, error.kind]).toEqual([0, "retry"]);
    expect(error.message).toContain("timed out");
  });

  it("never puts the token, PSU data or response bodies in error messages", async () => {
    const spy = replying({
      status: 422,
      body: {
        message: "Invalid PSU header",
        code: 422,
        error: "PSU_HEADER_INVALID",
        detail: "secret-detail-0001",
        echo: "body-echo-0002",
      },
    });
    const error = await rejection(clientWith(spy).getBalances(ACCOUNT_UID, PSU));
    const token = (sent(spy).headers.get("authorization") ?? "").replace(/^Bearer /, "");
    expect(token.length).toBeGreaterThan(100);
    for (const secret of [
      token,
      "203.0.113.7",
      "Mozilla",
      "secret-detail",
      "body-echo",
      ACCOUNT_UID,
    ]) {
      expect(error.message).not.toContain(secret);
    }
    expect(error.message).toBe("Enable Banking error 422 PSU_HEADER_INVALID: Invalid PSU header");
  });

  it("uses a configured https base URL", async () => {
    const spy = replying({ body: application });
    await clientWith(spy, { baseUrl: "https://api.sandbox.example.test" }).getApplication();
    expect(sent(spy).url.href).toBe("https://api.sandbox.example.test/application");
  });

  it("refuses an insecure base URL", () => {
    expect(() => clientWith(replying(), { baseUrl: "http://api.enablebanking.com" })).toThrow(
      /https/,
    );
  });
});
