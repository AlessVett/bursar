import { effectiveConnectionStatus } from "@bursar/shared";
import type { EventBus } from "../events/bus";
import { notificationKeys } from "../notifications/keys";
import type { NotificationService } from "../notifications/service";
import type { FinanceRepository } from "./repository";

export interface ConnectionStatusDeps {
  repo: FinanceRepository;
  notifications: NotificationService;
  bus: EventBus;
  now: () => number;
  timezone: string;
}

/**
 * Records that a connection can no longer be used until the owner renews the consent.
 * No-op for unknown or removed connections and when the stored status is already `status`,
 * so repeated failures raise one notification and one event. With `expectedSessionId` (the
 * session a failed request used) it is also a no-op once the connection holds another session:
 * a renewal that landed while the request waited on the bank must not be undone.
 */
export function markConnectionEnded(
  deps: ConnectionStatusDeps,
  connectionId: number,
  status: "expired" | "revoked" | "error",
  error?: { code: string | null; message: string | null },
  expectedSessionId?: string,
): void {
  const connection = deps.repo.getConnection(connectionId);
  if (!connection || connection.removedAt !== null || connection.status === status) return;
  if (expectedSessionId !== undefined && connection.providerSessionId !== expectedSessionId) {
    return;
  }
  const at = deps.now();
  const params = { bankName: connection.aspspName };
  deps.repo.transaction(() => {
    deps.repo.updateConnection(connectionId, {
      status,
      lastErrorCode: error?.code ?? null,
      lastErrorMessage: error?.message ?? null,
      lastErrorAt: error ? at : null,
      updatedAt: at,
    });
    if (status === "expired") {
      deps.notifications.raise({
        event: "consent_expired",
        dedupeKey: notificationKeys.consentExpired(connectionId, connection.validUntil),
        params,
        link: "/accounts",
      });
    } else {
      deps.notifications.raise({
        event: "connection_error",
        dedupeKey: notificationKeys.connectionError(connectionId, at),
        params,
        link: "/accounts",
      });
    }
  });
  deps.bus.publish({
    type: "connection.updated",
    connectionId,
    status: effectiveConnectionStatus(status, connection.validUntil, at, deps.timezone),
  });
}
