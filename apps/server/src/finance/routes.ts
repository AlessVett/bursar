import {
  accountPatchSchema,
  balanceHistoryQuerySchema,
  cashflowQuerySchema,
  searchQuerySchema,
  transactionQuerySchema,
} from "@bursar/shared";
import { type Context, Hono } from "hono";
import type { AuditLog } from "../audit";
import type { AppEnv } from "../http/app";
import {
  accountCurrency,
  balanceHistory,
  cashflow,
  getAccountDetail,
  getTransaction,
  homeSummary,
  listConnectionsView,
  listTransactions,
  type QueryDeps,
  searchAll,
  updateAccount,
} from "./queries";

export interface FinanceRouteDeps extends QueryDeps {
  audit: AuditLog;
  backup: () => { target: "local" | "s3"; consecutiveFailures: number };
}

/** A positive integer id from a URL segment; anything else cannot name a row. */
function parseId(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9]\d{0,14}$/u.test(value)) return null;
  return Number(value);
}

const notFound = (c: Context) => c.json({ error: "Not found", code: "not_found" }, 404);
const invalidQuery = (c: Context) => c.json({ error: "Invalid query", code: "invalid_query" }, 400);

/**
 * The read API of the panel plus the owner's account edits, mounted at `/api`. Ids appear only in
 * URLs and payloads, never in error messages.
 */
export function financeRoutes(deps: FinanceRouteDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/connections", (c) => c.json(listConnectionsView(deps)));

  routes.get("/accounts/:accountId", (c) => {
    const accountId = parseId(c.req.param("accountId"));
    const detail = accountId === null ? null : getAccountDetail(deps, accountId);
    return detail ? c.json(detail) : notFound(c);
  });

  routes.patch("/accounts/:accountId", async (c) => {
    const accountId = parseId(c.req.param("accountId"));
    if (accountId === null) return notFound(c);
    const parsed = accountPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Invalid account update", code: "invalid_body" }, 400);
    const result = updateAccount(deps, accountId, parsed.data);
    if (result === null) return notFound(c);
    if (result === "not_allowed") {
      return c.json({ error: "A removed account cannot be changed", code: "not_allowed" }, 409);
    }
    return c.json(result);
  });

  routes.get("/accounts/:accountId/balance-history", (c) => {
    const accountId = parseId(c.req.param("accountId"));
    const currency = accountId === null ? null : accountCurrency(deps, accountId);
    if (accountId === null || currency === null) return notFound(c);
    const query = balanceHistoryQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidQuery(c);
    // An account that has never reported a balance has no history yet: an empty series.
    return c.json(balanceHistory(deps, accountId, query.data.days) ?? { currency, points: [] });
  });

  routes.get("/transactions", (c) => {
    const query = transactionQuerySchema.safeParse(c.req.query());
    return query.success ? c.json(listTransactions(deps, query.data)) : invalidQuery(c);
  });

  routes.get("/transactions/:transactionId", (c) => {
    const transactionId = parseId(c.req.param("transactionId"));
    const detail = transactionId === null ? null : getTransaction(deps, transactionId);
    return detail ? c.json(detail) : notFound(c);
  });

  routes.get("/cashflow", (c) => {
    const query = cashflowQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalidQuery(c);
    const result = cashflow(deps, query.data);
    return result ? c.json(result) : c.body(null, 204);
  });

  routes.get("/summary", (c) => c.json(homeSummary(deps, deps.backup())));

  routes.get("/search", (c) => {
    const query = searchQuerySchema.safeParse(c.req.query());
    return query.success ? c.json(searchAll(deps, query.data.q)) : invalidQuery(c);
  });

  return routes;
}
