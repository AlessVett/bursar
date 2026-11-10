import type { AccountSummary, ConnectionSummary, RemovedAccountSummary } from "@bursar/shared";
import { CircleCheck, Landmark, RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, ConfirmDialog, EmptyState, InlineEmpty, PageHeader } from "../components/ui";
import { allUpdatedToday, attentionRank } from "../lib/connection-state";
import { useFormatters } from "../lib/format";
import { naturalCollator } from "../lib/search";
import { useConnectionsQuery } from "../lib/use-connections";
import { isGone, useAccountActions } from "./accounts/actions";
import { ConnectionCard } from "./accounts/ConnectionCard";
import { DisconnectDialog } from "./accounts/DisconnectDialog";
import { PurgeDialog } from "./accounts/PurgeDialog";
import { RemovedAccounts } from "./accounts/RemovedAccounts";
import { ConnectBankButton } from "./connect/ConnectBankButton";

const SKELETON_WIDTHS = ["w-48", "w-64", "w-40"] as const;

function AccountsSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="space-y-6">
      <span className="sr-only">{t("accounts.loading")}</span>
      {["first", "second"].map((card) => (
        <Card key={card} padding="none">
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="size-10 animate-pulse rounded-xl bg-surface-2" />
            <div className="h-4 w-40 animate-pulse rounded bg-surface-2" />
          </div>
          <div className="divide-y divide-subtle border-t border-subtle">
            {SKELETON_WIDTHS.map((width) => (
              <div key={width} className="flex items-center justify-between gap-4 px-4 py-4">
                <div className={`h-4 ${width} animate-pulse rounded bg-surface-2`} />
                <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * Accounts (UX doc §4): connections grouped by bank, each with the actions of its state machine,
 * the accounts of the connection, and the disconnected accounts that still hold transactions.
 */
export function AccountsPage() {
  const { t } = useTranslation();
  const { locale, now, timeZone } = useFormatters();
  const query = useConnectionsQuery();
  const actions = useAccountActions();
  const [disconnecting, setDisconnecting] = useState<ConnectionSummary | null>(null);
  const [disabling, setDisabling] = useState<AccountSummary | null>(null);
  const [purging, setPurging] = useState<RemovedAccountSummary | null>(null);

  const data = query.data;
  const connections = useMemo(() => {
    const collator = naturalCollator(locale);
    return [...(data?.connections ?? [])].sort(
      (a, b) =>
        attentionRank(a.status) - attentionRank(b.status) ||
        collator.compare(a.bankName, b.bankName) ||
        a.createdAt - b.createdAt,
    );
  }, [data, locale]);
  const removed = data?.removedAccounts ?? [];
  const accountCount = connections.reduce(
    (total, connection) => total + connection.accounts.length,
    0,
  );

  let content: ReactNode;
  if (!data) {
    content = query.isError ? (
      <Card>
        <EmptyState
          kind="state"
          icon={TriangleAlert}
          title={t("accounts.loadError.title")}
          description={t("accounts.loadError.body")}
          action={
            <Button variant="secondary" icon={RefreshCw} onClick={() => void query.refetch()}>
              {t("accounts.retry")}
            </Button>
          }
        />
      </Card>
    ) : (
      <AccountsSkeleton />
    );
  } else if (connections.length === 0 && removed.length === 0) {
    content = (
      <Card>
        <EmptyState
          kind="empty"
          icon={Landmark}
          title={t("accounts.empty.title")}
          description={t("accounts.empty.body")}
          action={<ConnectBankButton />}
        />
      </Card>
    );
  } else {
    content = (
      <div className="space-y-6">
        {allUpdatedToday(connections, now(), timeZone) ? (
          <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm font-medium text-positive">
            <CircleCheck aria-hidden size={18} strokeWidth={1.75} />
            {t("accounts.allUpdated")}
          </p>
        ) : null}
        {connections.length === 0 ? (
          <Card>
            <InlineEmpty
              icon={Landmark}
              title={t("accounts.noConnections.title")}
              description={t("accounts.noConnections.body")}
            />
          </Card>
        ) : null}
        {connections.map((connection, index) => (
          <ConnectionCard
            key={connection.id}
            connection={connection}
            index={index}
            actions={actions}
            onRequestDisconnect={setDisconnecting}
            onRequestDisable={setDisabling}
          />
        ))}
        {removed.length > 0 ? (
          <RemovedAccounts
            accounts={removed}
            index={connections.length}
            onRequestPurge={setPurging}
          />
        ) : null}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={t("routes.accounts.title")}
        count={data ? accountCount : undefined}
        subtitle={t("accounts.subtitle")}
        actions={<ConnectBankButton />}
      />
      {content}

      <ConfirmDialog
        open={disabling !== null}
        tone="primary"
        title={t("accounts.disable.title", { name: disabling?.name ?? "" })}
        body={t("accounts.disable.body", { name: disabling?.name ?? "" })}
        confirmLabel={t("accounts.disable.confirm")}
        busy={actions.setEnabled.isPending}
        onConfirm={async () => {
          if (!disabling) return;
          try {
            await actions.setEnabled.mutateAsync({ account: disabling, enabled: false });
          } catch (error) {
            // A refusal the server explains (the account was disconnected meanwhile) closes the
            // dialog, the lists were refreshed; anything else keeps it open for another try.
            if (!isGone(error)) throw error;
          }
        }}
        onCancel={() => setDisabling(null)}
      />
      <DisconnectDialog connection={disconnecting} onClose={() => setDisconnecting(null)} />
      <PurgeDialog account={purging} onClose={() => setPurging(null)} />
    </>
  );
}
