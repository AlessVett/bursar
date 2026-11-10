import { createHash } from "node:crypto";
import type {
  AccountStatus,
  DisconnectResponse,
  PurgeResponse,
  RemovalPreview,
} from "@bursar/shared";
import type { AuditLog } from "../audit";
import type { EnableBankingApi } from "../eb/client";
import { EnableBankingError } from "../eb/errors";
import type { EventBus } from "../events/bus";
import type { JobQueue } from "../jobs/queue";
import {
  DELETE_SESSION_JOB,
  type DeleteSessionPayload,
  deleteSessionPayloadSchema,
  parsePayload,
  syncDedupeKey,
  syncFollowUpDedupeKey,
} from "../jobs/types";
import { type JobHandler, PermanentJobError } from "../jobs/worker";
import type { FinanceRepository } from "./repository";

/** Enable Banking answers with one of these when the session is already over: nothing to close. */
export const SESSION_ENDED_CODES: ReadonlySet<string> = new Set([
  "CLOSED_SESSION",
  "EXPIRED_SESSION",
  "SESSION_DOES_NOT_EXIST",
  "REVOKED_SESSION",
]);

/** The first retry waits a little: the bank has just failed to answer. */
export const DELETE_SESSION_RETRY_DELAY_MS = 5 * 60_000;
/** With the queue backoff: retries after 30 s, 2 min, 8 min, 32 min and 1 h. */
export const DELETE_SESSION_MAX_ATTEMPTS = 6;

const LIVE_ACCOUNT_STATUSES: readonly AccountStatus[] = ["active", "disabled", "unavailable"];

export function isSessionEnded(error: unknown): boolean {
  return (
    error instanceof EnableBankingError &&
    error.code !== null &&
    SESSION_ENDED_CODES.has(error.code)
  );
}

/** The provider session id stays in the job payload only; the key carries a hash of it. */
export function deleteSessionDedupeKey(providerSessionId: string): string {
  const digest = createHash("sha256").update(providerSessionId).digest("hex");
  return `delete-session:${digest.slice(0, 32)}`;
}

export function enqueueSessionDeletion(
  queue: JobQueue,
  providerSessionId: string,
  now: number,
): { id: number; created: boolean } {
  const payload: DeleteSessionPayload = { providerSessionId };
  return queue.enqueueUnique(
    DELETE_SESSION_JOB,
    deleteSessionDedupeKey(providerSessionId),
    payload,
    {
      runAfter: now + DELETE_SESSION_RETRY_DELAY_MS,
      maxAttempts: DELETE_SESSION_MAX_ATTEMPTS,
    },
  );
}

export class AlreadyRemovedError extends Error {
  constructor() {
    super("The connection is already removed");
    this.name = "AlreadyRemovedError";
  }
}

export interface ConnectionLifecycleDeps {
  repo: FinanceRepository;
  api: EnableBankingApi | null;
  queue: JobQueue;
  bus: EventBus;
  audit: AuditLog;
  now?: () => number;
}

type RemoteSessionOutcome = "closed" | "already_ended" | "queued" | "local_only";

/**
 * Disconnecting a bank and purging what it left behind (spec §6.3). A disconnect keeps every
 * transaction; purging an account's data is a separate, explicitly confirmed action.
 */
export class ConnectionLifecycle {
  private readonly now: () => number;

  constructor(private readonly deps: ConnectionLifecycleDeps) {
    this.now = deps.now ?? Date.now;
  }

  removalPreview(connectionId: number): RemovalPreview | null {
    const { repo } = this.deps;
    const connection = repo.getConnection(connectionId);
    if (!connection) return null;
    const accounts = repo.listAccounts({ connectionId, statuses: LIVE_ACCOUNT_STATUSES });
    const transactions = accounts.reduce(
      (sum, account) => sum + repo.countTransactions(account.id).total,
      0,
    );
    return { bankName: connection.aspspName, accounts: accounts.length, transactions };
  }

  /**
   * Marks the connection and its accounts removed in one transaction, then closes the bank
   * session (best effort, retried by a job). Throws {@link AlreadyRemovedError} when it is
   * removed. Removing first means a sync still waiting on the bank, which hears about the closed
   * session, finds its account removed and changes nothing (no `connection_error` for a bank the
   * owner just disconnected).
   */
  async disconnect(connectionId: number): Promise<DisconnectResponse | null> {
    const { repo, queue, audit, bus } = this.deps;
    const connection = repo.getConnection(connectionId);
    if (!connection) return null;
    if (connection.removedAt !== null) throw new AlreadyRemovedError();

    const now = this.now();
    const removedAccounts = repo.transaction((): number => {
      repo.updateConnection(connectionId, { removedAt: now });
      const accounts = repo.listAccounts({ connectionId, statuses: LIVE_ACCOUNT_STATUSES });
      for (const account of accounts) {
        repo.updateAccount(account.id, { status: "removed", removedAt: now });
        queue.cancelQueued(syncDedupeKey(account.id));
        queue.cancelQueued(syncFollowUpDedupeKey(account.id));
      }
      return accounts.length;
    });

    const remoteSession = await this.closeRemoteSession(connection.providerSessionId);
    audit.record({
      actor: "user",
      action: "connection.remove",
      target: `connection:${connectionId}`,
      details: { accounts: removedAccounts, remoteSession },
    });

    // No time zone in this service: the event carries the stored status; the panel refetches.
    bus.publish({ type: "connection.updated", connectionId, status: connection.status });
    return { removedAccounts };
  }

  /** Deletes a removed account's data; deletes the connection row once its last account is gone. */
  purgeAccount(accountId: number): PurgeResponse | "not_removed" | null {
    const { repo, queue, audit } = this.deps;
    const account = repo.getAccount(accountId);
    if (!account) return null;
    if (account.status !== "removed") return "not_removed";

    queue.cancelQueued(syncDedupeKey(accountId));
    queue.cancelQueued(syncFollowUpDedupeKey(accountId));
    const counts = repo.purgeAccount(accountId);
    const connection = repo.getConnection(account.connectionId);
    const connectionDeleted =
      connection !== null &&
      connection.removedAt !== null &&
      repo.listAccounts({ connectionId: connection.id }).length === 0 &&
      repo.deleteConnection(connection.id);

    audit.record({
      actor: "user",
      action: "account.purge",
      target: `account:${accountId}`,
      details: {
        transactions: counts.transactions,
        balances: counts.balances,
        syncRuns: counts.syncRuns,
        connectionDeleted,
      },
    });
    return { transactions: counts.transactions, balances: counts.balances };
  }

  private async closeRemoteSession(providerSessionId: string): Promise<RemoteSessionOutcome> {
    const { api, queue } = this.deps;
    if (!api) return "local_only";
    try {
      // No PSU headers: the owner is not at the bank, and a close never needs them.
      await api.deleteSession(providerSessionId);
      return "closed";
    } catch (error) {
      if (isSessionEnded(error)) return "already_ended";
      enqueueSessionDeletion(queue, providerSessionId, this.now());
      return "queued";
    }
  }
}

/**
 * `bank.delete-session`: closes a provider session left open by a disconnect or a renewal.
 * Error messages are the reduced `EnableBankingError` messages, never the session id.
 */
export function deleteSessionJobHandler(deps: { api: EnableBankingApi | null }): JobHandler {
  return async (job) => {
    const { providerSessionId } = parsePayload(deleteSessionPayloadSchema, job);
    if (!deps.api) throw new PermanentJobError("Enable Banking is not configured");
    try {
      await deps.api.deleteSession(providerSessionId);
    } catch (error) {
      if (isSessionEnded(error)) return;
      if (error instanceof EnableBankingError) {
        if (error.kind === "retry" || error.kind === "rate_limited") throw error;
        throw new PermanentJobError(error.message);
      }
      throw new PermanentJobError("Closing the bank session failed unexpectedly");
    }
  };
}
