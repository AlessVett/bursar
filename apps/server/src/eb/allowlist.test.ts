import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assertAllowed, DisallowedOperationError, EB_ALLOWED_OPERATIONS } from "./allowlist";
import { EnableBankingClient } from "./client";

const ID = "cf37e3b7-4361-48a5-9d12-b4bf06b46b6e";
const API_METHODS = [
  "createSession",
  "deleteSession",
  "getApplication",
  "getBalances",
  "getSession",
  "getTransactions",
  "listAspsps",
  "startAuthorization",
];

const ALLOWED: [string, string][] = [
  ["GET", "/application"],
  ["GET", "/aspsps"],
  ["POST", "/auth"],
  ["POST", "/sessions"],
  ["GET", `/sessions/${ID}`],
  ["DELETE", `/sessions/${ID}`],
  ["GET", `/accounts/${ID}/balances`],
  ["GET", `/accounts/${ID}/transactions`],
];

const DISALLOWED: [string, string][] = [
  // Payment initiation (eb-api-notes.md §11): never reachable.
  ["POST", "/payments"],
  ["POST", "/payments/"],
  ["GET", `/payments/${ID}`],
  ["DELETE", `/payments/${ID}`],
  ["POST", `/payments/${ID}/submit`],
  ["GET", `/payments/${ID}/transactions/tx-0001`],
  // Account-information operations Bursar does not use.
  ["GET", `/accounts/${ID}/transactions/tx-0001`],
  ["GET", `/accounts/${ID}/details`],
  ["POST", `/accounts/${ID}/balances`],
  ["PUT", `/sessions/${ID}`],
  ["POST", "/applications"],
  // Path tricks.
  ["GET", `/accounts/${ID}/../../payments`],
  ["GET", `/accounts/${ID}/balances/../../../payments`],
  ["GET", "/aspsps?service=PIS"],
  ["GET", `/accounts/${ID}/transactions?status=BOOK`],
  ["GET", "https://evil.example.test/aspsps"],
  ["GET", "//evil.example.test/aspsps"],
  ["GET", "/aspsps/"],
  ["GET", "/aspsps\n"],
  ["GET", "/sessions/not-a-uuid"],
  ["get", "/aspsps"],
  ["GET", ""],
];

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

type CallFn = (method: string, path: string, options: object) => Promise<unknown>;

describe("Enable Banking allowlist", () => {
  it("allows exactly the eight account-information operations", () => {
    expect(EB_ALLOWED_OPERATIONS).toHaveLength(8);
    expect(EB_ALLOWED_OPERATIONS.map((operation) => operation.name).sort()).toEqual(API_METHODS);
    for (const [method, path] of ALLOWED) {
      expect(assertAllowed(method, path).method).toBe(method);
    }
  });

  it("rejects every payment path and every operation not on the list", () => {
    for (const [method, path] of DISALLOWED) {
      expect(() => assertAllowed(method, path), `${method} ${path}`).toThrow(
        DisallowedOperationError,
      );
    }
  });

  it("does not echo identifiers in the rejection message", () => {
    expect(() => assertAllowed("GET", `/payments/${ID}`)).toThrow(/\{id\}/);
    try {
      assertAllowed("GET", `/payments/${ID}`);
    } catch (error) {
      expect(String(error)).not.toContain(ID);
    }
  });

  it("makes the client fail before any network call", async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response("{}"));
    const client = new EnableBankingClient({
      applicationId: ID,
      privateKeyPem: privateKey,
      fetch: fetchSpy,
    });
    const call = (client as unknown as { call: CallFn }).call;
    for (const [method, path] of DISALLOWED) {
      await expect(call(method, path, {}), `${method} ${path}`).rejects.toBeInstanceOf(
        DisallowedOperationError,
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exposes only the eight API methods on the client's prototype", () => {
    const names = Object.getOwnPropertyNames(EnableBankingClient.prototype)
      .filter((name) => name !== "constructor")
      .sort();
    expect(names).toEqual(API_METHODS);
    const client = new EnableBankingClient({ applicationId: ID, privateKeyPem: privateKey });
    const record = client as unknown as Record<string, unknown>;
    for (const generic of ["request", "fetch", "send", "post", "get", "delete"]) {
      expect(record[generic]).toBeUndefined();
    }
  });
});
