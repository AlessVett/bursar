import {
  effectiveConnectionStatus,
  type SyncConflictCode,
  type SyncQueuedResponse,
} from "@bursar/shared";
import { type Context, Hono } from "hono";
import type { PsuHeaders } from "../eb/client";
import type { AppEnv } from "../http/app";
import { isPublicIp } from "../http/client-ip";
import type { JobQueue } from "../jobs/queue";
import { syncDedupeKey } from "../jobs/types";
import type { AccountRow, ConnectionRow, FinanceRepository } from "./repository";
import { enqueueAccountSync } from "./sync";

export interface SyncRoutesDeps {
  repo: FinanceRepository;
  queue: JobQueue;
  clientIp: (c: Context) => string;
  timezone: string;
  now?: () => number;
}

interface Conflict {
  error: string;
  code: SyncConflictCode;
  retryAt?: number;
}

const NOT_FOUND = { error: "Not found", code: "not_found" } as const;
const ACCOUNT_INACTIVE: Conflict = {
  error: "This account cannot be synced",
  code: "account_inactive",
};
const CONNECTION_INACTIVE: Conflict = {
  error: "This bank connection needs a new consent before it can sync",
  code: "connection_inactive",
};
const IN_PROGRESS: Conflict = {
  error: "A sync is already running for this account",
  code: "sync_in_progress",
};
const NOTHING_TO_SYNC: Conflict = {
  error: "No account of this connection can be synced now",
  code: "nothing_to_sync",
};
const ID_PATTERN = /^[1-9]\d{0,15}$/;
const MAX_HEADER_LENGTH = 512;

function parseId(value: string): number | null {
  if (!ID_PATTERN.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function connectionConflict(
  connection: ConnectionRow,
  now: number,
  timezone: string,
): Conflict | null {
  if (connection.removedAt !== null) return CONNECTION_INACTIVE;
  const status = effectiveConnectionStatus(connection.status, connection.validUntil, now, timezone);
  return status === "active" || status === "expiring" ? null : CONNECTION_INACTIVE;
}

function accountConflict(account: AccountRow): Conflict | null {
  return account.status === "active" && account.providerAccountUid !== null
    ? null
    : ACCOUNT_INACTIVE;
}

function availabilityConflict(account: AccountRow, now: number, queue: JobQueue): Conflict | null {
  if (account.rateLimitedUntil !== null && account.rateLimitedUntil > now) {
    return {
      error: "The bank asked to pause syncing this account",
      code: "rate_limited",
      retryAt: account.rateLimitedUntil,
    };
  }
  return queue.findActive(syncDedupeKey(account.id)) ? IN_PROGRESS : null;
}

function clip(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_HEADER_LENGTH) : undefined;
}

/** The user is present: forward who they are, but only with a public address and a browser. */
function psuHeaders(c: Context<AppEnv>, clientIp: (c: Context) => string): PsuHeaders | undefined {
  const ipAddress = clientIp(c);
  const userAgent = clip(c.req.header("user-agent"));
  if (!userAgent || !isPublicIp(ipAddress)) return undefined;
  const headers: PsuHeaders = { ipAddress, userAgent };
  const accept = clip(c.req.header("accept"));
  const acceptLanguage = clip(c.req.header("accept-language"));
  if (accept) headers.accept = accept;
  if (acceptLanguage) headers.acceptLanguage = acceptLanguage;
  return headers;
}

/** The 409 to answer when a connection had accounts but none could be queued. */
function connectionRefusal(conflicts: readonly Conflict[]): Conflict {
  if (conflicts.some((conflict) => conflict.code === "sync_in_progress")) return IN_PROGRESS;
  let earliest: Conflict | null = null;
  for (const conflict of conflicts) {
    if (conflict.code !== "rate_limited" || conflict.retryAt === undefined) continue;
    if (earliest === null || conflict.retryAt < (earliest.retryAt ?? Number.POSITIVE_INFINITY)) {
      earliest = conflict;
    }
  }
  return earliest ?? NOTHING_TO_SYNC;
}

export function syncRoutes(deps: SyncRoutesDeps): Hono<AppEnv> {
  const now = deps.now ?? Date.now;
  const routes = new Hono<AppEnv>();

  routes.post("/accounts/:accountId/sync", (c) => {
    const id = parseId(c.req.param("accountId"));
    const account = id === null ? null : deps.repo.getAccount(id);
    const connection = account ? deps.repo.getConnection(account.connectionId) : null;
    if (!account || !connection) return c.json(NOT_FOUND, 404);
    const at = now();
    const conflict =
      accountConflict(account) ??
      connectionConflict(connection, at, deps.timezone) ??
      availabilityConflict(account, at, deps.queue);
    if (conflict) return c.json(conflict, 409);
    enqueueAccountSync(deps.queue, account.id, "manual", psuHeaders(c, deps.clientIp));
    return c.json({ queued: 1 } satisfies SyncQueuedResponse, 202);
  });

  routes.post("/connections/:connectionId/sync", (c) => {
    const id = parseId(c.req.param("connectionId"));
    const connection = id === null ? null : deps.repo.getConnection(id);
    if (!connection) return c.json(NOT_FOUND, 404);
    const at = now();
    const inactive = connectionConflict(connection, at, deps.timezone);
    if (inactive) return c.json(inactive, 409);
    const psu = psuHeaders(c, deps.clientIp);
    const conflicts: Conflict[] = [];
    let queued = 0;
    for (const account of deps.repo.listAccounts({
      connectionId: connection.id,
      statuses: ["active"],
    })) {
      const conflict = accountConflict(account) ?? availabilityConflict(account, at, deps.queue);
      if (conflict) {
        conflicts.push(conflict);
        continue;
      }
      enqueueAccountSync(deps.queue, account.id, "manual", psu);
      queued += 1;
    }
    if (queued === 0) return c.json(connectionRefusal(conflicts), 409);
    return c.json({ queued } satisfies SyncQueuedResponse, 202);
  });

  return routes;
}
