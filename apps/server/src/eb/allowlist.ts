/**
 * The only Enable Banking operations Bursar may call: account information, never payments
 * (spec §6.3, eb-api-notes.md §11). `EnableBankingClient` checks this list before signing a token
 * or touching the network. Adding an entry is a security-relevant change.
 */
export interface EbOperation {
  name: string;
  method: "GET" | "POST" | "DELETE";
  pattern: RegExp;
}

const UUID = "[0-9a-fA-F-]{36}";

const OPERATIONS: EbOperation[] = [
  { name: "getApplication", method: "GET", pattern: /^\/application$/ },
  { name: "listAspsps", method: "GET", pattern: /^\/aspsps$/ },
  { name: "startAuthorization", method: "POST", pattern: /^\/auth$/ },
  { name: "createSession", method: "POST", pattern: /^\/sessions$/ },
  { name: "getSession", method: "GET", pattern: new RegExp(`^/sessions/${UUID}$`) },
  { name: "deleteSession", method: "DELETE", pattern: new RegExp(`^/sessions/${UUID}$`) },
  { name: "getBalances", method: "GET", pattern: new RegExp(`^/accounts/${UUID}/balances$`) },
  {
    name: "getTransactions",
    method: "GET",
    pattern: new RegExp(`^/accounts/${UUID}/transactions$`),
  },
];

export const EB_ALLOWED_OPERATIONS: readonly EbOperation[] = Object.freeze(
  OPERATIONS.map((operation) => Object.freeze(operation)),
);

const UUID_GLOBAL = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

export class DisallowedOperationError extends Error {
  constructor(method: string, path: string) {
    const shown = JSON.stringify(path.slice(0, 120).replace(UUID_GLOBAL, "{id}"));
    super(`Enable Banking operation not allowed: ${JSON.stringify(method.slice(0, 10))} ${shown}`);
    this.name = "DisallowedOperationError";
  }
}

/** Throws unless `method` and `path` (no query string, no host) match an allowed operation. */
export function assertAllowed(method: string, path: string): EbOperation {
  const operation = EB_ALLOWED_OPERATIONS.find(
    (candidate) => candidate.method === method && candidate.pattern.test(path),
  );
  if (!operation) throw new DisallowedOperationError(method, path);
  return operation;
}
