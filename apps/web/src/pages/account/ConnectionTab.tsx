import type { AccountDetailResponse } from "@bursar/shared";
import { Check, RefreshCw, RotateCw, Unplug } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, DeadlineChip, StatusPill } from "../../components/ui";
import { connectionTone } from "../../lib/connection-state";
import { useFormatters } from "../../lib/format";
import { consentUrgency } from "../../lib/thresholds";
import { DisconnectDialog } from "../accounts/DisconnectDialog";
import { type AccountActionKind, accountActionStates } from "./account-state";
import { consentLabel, errorLabel } from "./labels";
import { SyncHistory } from "./SyncHistory";
import { useAccountActions } from "./useAccountActions";

const ACTION_ICON = {
  sync: RefreshCw,
  renew: RotateCw,
  enable: Check,
  disconnect: Unplug,
} as const;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-44 shrink-0 text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-fg">{children}</dd>
    </div>
  );
}

/** Region name in the interface language ("Italy"), falling back to the country code. */
function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Connection: consent, dates, last error, the actions of the state machine and the sync history. */
export function ConnectionTab({ detail }: { detail: AccountDetailResponse }) {
  const { t } = useTranslation();
  const { absolute, relative, locale, now, timeZone } = useFormatters();
  const actions = useAccountActions(detail);
  const [disconnecting, setDisconnecting] = useState(false);
  const { account, connection } = detail;

  const consent = consentUrgency(connection.validUntil, now(), timeZone);
  const states = accountActionStates(detail, now());
  const pausedUntil =
    account.rateLimitedUntil !== null && account.rateLimitedUntil > now()
      ? account.rateLimitedUntil
      : null;

  const press = (action: AccountActionKind) => {
    if (action === "disconnect") setDisconnecting(true);
    else actions.run(action);
  };

  return (
    <div className="space-y-5">
      <Card padding="lg">
        <h2 className="mb-2 font-display text-base font-semibold text-fg">
          {t("account.connection.title")}
        </h2>
        <dl className="divide-y divide-subtle">
          <Fact label={t("account.connection.bank")}>
            {connection.bankName}
            <span className="text-muted"> · {countryName(connection.country, locale)}</span>
          </Fact>
          <Fact label={t("account.connection.status")}>
            <StatusPill
              tone={connectionTone(connection.status)}
              label={t(`account.status.${connection.status}`)}
            />
          </Fact>
          <Fact label={t("account.connection.validUntil")}>
            <span className="flex flex-wrap items-center gap-2">
              <span>{absolute(connection.validUntil)}</span>
              <DeadlineChip
                urgency={consent.urgency}
                label={consentLabel(t, consent)}
                title={absolute(connection.validUntil, true)}
              />
            </span>
          </Fact>
          <Fact label={t("account.connection.connectedOn")}>{absolute(connection.createdAt)}</Fact>
          <Fact label={t("account.connection.renewedOn")}>
            {connection.renewedAt === null ? (
              <span className="text-muted">{t("account.connection.notRenewed")}</span>
            ) : (
              absolute(connection.renewedAt)
            )}
          </Fact>
          <Fact label={t("account.connection.lastUpdate")}>
            {account.lastSyncedAt === null ? (
              <span className="text-muted">{t("account.connection.never")}</span>
            ) : (
              <time title={absolute(account.lastSyncedAt, true)}>
                {relative(account.lastSyncedAt)}
              </time>
            )}
          </Fact>
          {pausedUntil !== null ? (
            <Fact label={t("account.connection.pausedUntil")}>{relative(pausedUntil)}</Fact>
          ) : null}
          <Fact label={t("account.connection.lastError")}>
            {connection.lastError === null && account.lastSyncError === null ? (
              <span className="text-muted">{t("account.connection.noError")}</span>
            ) : (
              <span className="flex flex-col gap-1">
                {connection.lastError !== null ? (
                  <span>
                    {t("account.connection.connectionError", {
                      reason: errorLabel(t, connection.lastError.code),
                      when: relative(connection.lastError.at),
                    })}
                  </span>
                ) : null}
                {account.lastSyncError !== null ? (
                  <span>
                    {t("account.connection.updateError", {
                      reason: errorLabel(t, account.lastSyncError.code),
                      when: relative(account.lastSyncError.at),
                    })}
                  </span>
                ) : null}
              </span>
            )}
          </Fact>
        </dl>
      </Card>

      <Card padding="lg">
        <h2 className="mb-3 font-display text-base font-semibold text-fg">
          {t("account.connection.actionsTitle")}
        </h2>
        {states.length === 0 ? (
          <p className="text-sm text-muted">{t("account.connection.removedNote")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {states.map((state) => (
              <Button
                key={state.action}
                variant={
                  state.primary ? "primary" : state.action === "disconnect" ? "danger" : "secondary"
                }
                icon={ACTION_ICON[state.action]}
                loading={state.action !== "disconnect" && actions.pending[state.action]}
                disabled={state.blockedKey !== null}
                title={state.blockedKey !== null ? t(state.blockedKey) : undefined}
                data-qa-skip={state.action === "renew" ? "" : undefined}
                onClick={() => press(state.action)}
              >
                {t(`account.actions.${state.action}`)}
              </Button>
            ))}
          </div>
        )}
      </Card>

      <Card padding="lg">
        <h2 className="mb-3 font-display text-base font-semibold text-fg">
          {t("account.sync.title")}
        </h2>
        <SyncHistory runs={detail.syncRuns} />
      </Card>

      <DisconnectDialog
        connection={disconnecting ? { id: connection.id, bankName: connection.bankName } : null}
        onClose={() => setDisconnecting(false)}
      />
    </div>
  );
}
