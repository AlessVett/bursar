import { useQuery } from "@tanstack/react-query";
import { SearchX, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { ApiError, api } from "../api";
import { BackButton } from "../app/BackButton";
import { Breadcrumbs } from "../app/Breadcrumbs";
import { buildPath } from "../app/routes";
import { Button, Cascade, EmptyState, Tabs } from "../components/ui";
import { queryKeys } from "../lib/query-keys";
import { useUrlState } from "../lib/url-state";
import { AccountHero } from "./account/AccountHero";
import { type AccountTab, isAccountTab } from "./account/account-state";
import { ConnectionTab } from "./account/ConnectionTab";
import { OverviewTab } from "./account/OverviewTab";
import { TransactionsTab } from "./account/TransactionsTab";

/** A positive integer path segment, or null (so `abc`, `0`, `-1` and `1.5` never reach the API). */
function parseAccountId(raw: string | undefined): number | null {
  return raw !== undefined && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
}

function Trail({ current }: { current: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <BackButton routeId="account" />
      <Breadcrumbs routeId="account" current={current} />
    </div>
  );
}

function AccountNotFound() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <Trail current={t("account.notFound.crumb")} />
      <EmptyState
        kind="notFound"
        icon={SearchX}
        title={t("account.notFound.title")}
        description={t("account.notFound.description")}
        action={
          <Button variant="primary" onClick={() => navigate(buildPath("accounts"))}>
            {t("account.notFound.back")}
          </Button>
        }
      />
    </div>
  );
}

function DetailSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="space-y-5">
      <p className="sr-only">{t("common.loading")}</p>
      <div className="h-5 w-56 animate-pulse rounded bg-surface-2" />
      <div className="overflow-hidden rounded-2xl border border-subtle bg-surface">
        <div className="h-1.5 bg-surface-2" />
        <div className="grid gap-4 p-6 md:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div className="h-7 w-64 animate-pulse rounded bg-surface-2" />
            <div className="h-4 w-40 animate-pulse rounded bg-surface-2" />
            <div className="h-6 w-72 animate-pulse rounded bg-surface-2" />
          </div>
          <div className="h-12 w-44 animate-pulse rounded bg-surface-2" />
        </div>
      </div>
      <div className="h-64 animate-pulse rounded-2xl bg-surface-2" />
    </div>
  );
}

/** `/accounts/:accountId`: hero, then the Overview, Transactions and Connection tabs (`?tab=`). */
export function AccountDetailPage() {
  const { t } = useTranslation();
  const accountId = parseAccountId(useParams().accountId);
  const [url, setUrl] = useUrlState({ tab: "overview" }, { validate: { tab: isAccountTab } });
  const query = useQuery({
    queryKey: queryKeys.account(accountId ?? 0),
    queryFn: () => api.account(accountId ?? 0),
    enabled: accountId !== null,
  });

  if (accountId === null || (query.error instanceof ApiError && query.error.status === 404)) {
    return <AccountNotFound />;
  }
  if (query.isError && !query.data) {
    return (
      <div className="space-y-6">
        <Trail current={t("account.loadError.crumb")} />
        <EmptyState
          kind="state"
          icon={TriangleAlert}
          title={t("account.loadError.title")}
          description={t("account.loadError.description")}
          action={
            <Button variant="secondary" onClick={() => query.refetch()}>
              {t("account.retry")}
            </Button>
          }
        />
      </div>
    );
  }
  if (!query.data) return <DetailSkeleton />;

  const detail = query.data;
  const tab = url.tab as AccountTab;

  return (
    <div className="space-y-5">
      <Trail current={detail.account.name} />
      <Cascade index={0}>
        <AccountHero detail={detail} />
      </Cascade>
      <Cascade index={1}>
        <Tabs
          ariaLabel={t("account.tabs.label")}
          value={tab}
          onChange={(id) => setUrl({ tab: id })}
          items={[
            { id: "overview", label: t("account.tabs.overview") },
            {
              id: "transactions",
              label: t("account.tabs.transactions"),
              count: detail.transactionCount,
            },
            { id: "connection", label: t("account.tabs.connection") },
          ]}
        />
      </Cascade>
      <Cascade index={0} key={tab}>
        <div role="tabpanel" aria-label={t(`account.tabs.${tab}`)}>
          {tab === "overview" ? (
            <OverviewTab detail={detail} onSelectTab={(next) => setUrl({ tab: next })} />
          ) : tab === "transactions" ? (
            <TransactionsTab accountId={detail.account.id} />
          ) : (
            <ConnectionTab detail={detail} />
          )}
        </div>
      </Cascade>
    </div>
  );
}
