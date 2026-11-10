import { calendarDaysUntil, EXPIRING_THRESHOLD_DAYS, URGENT_THRESHOLD_DAYS } from "@bursar/shared";
import type { Logger } from "pino";
import type { EnableBankingApi } from "../eb/client";
import { EnableBankingError } from "../eb/errors";
import type { EbSessionStatus } from "../eb/schemas";
import type { EventBus } from "../events/bus";
import { notificationKeys } from "../notifications/keys";
import type { NotificationService } from "../notifications/service";
import type { ScheduledTask } from "../scheduler";
import { markConnectionEnded } from "./connection-status";
import type { ConnectionRow, FinanceRepository } from "./repository";

/** `GET /sessions/{id}` is asked at most this often per connection. */
export const SESSION_STATUS_CHECK_INTERVAL_MS = 24 * 3_600_000;

type EndedStatus = "expired" | "revoked" | "error";

/**
 * Session states that end a connection (eb-api-notes.md §6, medium confidence). AUTHORIZED,
 * PENDING_AUTHORIZATION and RETURNED_FROM_BANK leave it alone.
 */
export const SESSION_STATUS_OUTCOMES: Readonly<
  Partial<Record<EbSessionStatus["status"], EndedStatus>>
> = {
  EXPIRED: "expired",
  REVOKED: "revoked",
  CLOSED: "error",
  CANCELLED: "error",
  INVALID: "error",
};

/** Same mapping as the sync job (Task 13) for a reauth-kind Enable Banking error. */
export function endedStatusForReauthCode(code: string | null): EndedStatus {
  if (code === "EXPIRED_SESSION") return "expired";
  if (code === "REVOKED_SESSION") return "revoked";
  return "error";
}

export interface ConsentTaskDeps {
  repo: FinanceRepository;
  api: EnableBankingApi | null;
  notifications: NotificationService;
  bus: EventBus;
  timezone: string;
  now: () => number;
  logger: Logger;
}

/**
 * Runs on every scheduler tick and decides from stored state alone: consent expiry by date, a
 * daily bank-side session check, and the 14- and 3-day notices (spec §6.3, §6.9). Notices are
 * keyed by `validUntil`, so a renewal starts the thresholds over.
 */
export function consentTask(deps: ConsentTaskDeps): ScheduledTask {
  async function sessionHasEnded(connection: ConnectionRow, now: number): Promise<boolean> {
    const { api } = deps;
    if (!api) return false;
    if (
      connection.statusCheckedAt !== null &&
      now - connection.statusCheckedAt < SESSION_STATUS_CHECK_INTERVAL_MS
    ) {
      return false;
    }
    // Recorded before the call, so a failing check is retried the next day, not on every tick.
    deps.repo.updateConnection(connection.id, { statusCheckedAt: now });
    let status: EbSessionStatus["status"];
    try {
      status = (await api.getSession(connection.providerSessionId)).status;
    } catch (error) {
      if (error instanceof EnableBankingError && error.kind === "reauth") {
        markConnectionEnded(deps, connection.id, endedStatusForReauthCode(error.code), {
          code: error.code,
          message: null,
        });
        return true;
      }
      const ebError = error instanceof EnableBankingError ? error : null;
      deps.logger.warn(
        {
          connectionId: connection.id,
          status: ebError ? ebError.status : null,
          code: ebError ? ebError.code : null,
        },
        "Bank session status check failed",
      );
      return false;
    }
    const ended = SESSION_STATUS_OUTCOMES[status];
    if (!ended) return false;
    markConnectionEnded(deps, connection.id, ended, { code: `SESSION_${status}`, message: null });
    return true;
  }

  function raiseExpiryNotice(connection: ConnectionRow, now: number): void {
    const days = calendarDaysUntil(connection.validUntil, now, deps.timezone);
    // Only the most urgent threshold applies to one evaluation.
    const threshold =
      days <= URGENT_THRESHOLD_DAYS ? 3 : days <= EXPIRING_THRESHOLD_DAYS ? 14 : null;
    if (threshold === null) return;
    deps.notifications.raise({
      event: "consent_expiring",
      dedupeKey: notificationKeys.consentExpiring(connection.id, connection.validUntil, threshold),
      params: { bankName: connection.aspspName, days },
      link: "/accounts",
    });
  }

  return {
    name: "consent-lifecycle",
    async run() {
      const now = deps.now();
      for (const connection of deps.repo.listConnections()) {
        if (connection.removedAt !== null || connection.status !== "active") continue;
        if (connection.validUntil <= now) {
          markConnectionEnded(deps, connection.id, "expired");
          continue;
        }
        if (await sessionHasEnded(connection, now)) continue;
        raiseExpiryNotice(connection, now);
      }
    },
  };
}
