import { type TransactionTab, toLocalDate, transactionTabSchema } from "@bursar/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { api } from "../api";
import { buildPath } from "../app/routes";
import { useSettingsQuery } from "../app/useSettingsQuery";
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  type SortState,
  Tabs,
} from "../components/ui";
import { useFormatters } from "../lib/format";
import { queryKeys } from "../lib/query-keys";
import { useUrlState } from "../lib/url-state";
import { CashFlowAggregate } from "./transactions/CashFlowAggregate";
import {
  DEFAULT_PERIOD,
  isLocalDate,
  isPeriodPreset,
  type PeriodState,
  readPeriod,
} from "./transactions/period";
import { PRIMARY_LINK_CLASS, TransactionDrawer } from "./transactions/TransactionDrawer";
import { type AccountOption, TransactionFilters } from "./transactions/TransactionFilters";
import { TransactionTable } from "./transactions/TransactionTable";

const PAGE_SIZE = 20;
const TABS: readonly TransactionTab[] = ["all", "in", "out", "pending"];
const SORT_COLUMNS: readonly string[] = ["date", "amount", "counterparty"];
const POSITIVE_ID = /^[1-9]\d{0,9}$/;
/** Probe requests only need `total`; the list itself always uses the server default (20). */
const PROBE_PAGE_SIZE = "10";
const ALL_TIME_PARAMS: Record<string, string> = { pageSize: PROBE_PAGE_SIZE };

/** The list state in the URL; a value equal to its default is absent from the URL. */
export const LIST_DEFAULTS = {
  q: "",
  tab: "all",
  accountId: "",
  period: "30d",
  from: "",
  to: "",
  currency: "",
  sort: "date",
  order: "desc",
  page: "1",
};

export type TransactionUrlState = typeof LIST_DEFAULTS;

const LIST_RULES: Partial<Record<keyof TransactionUrlState, (value: string) => boolean>> = {
  q: (value) => value.length <= 100,
  tab: (value) => transactionTabSchema.safeParse(value).success,
  accountId: (value) => POSITIVE_ID.test(value),
  period: isPeriodPreset,
  from: isLocalDate,
  to: isLocalDate,
  currency: (value) => /^[A-Z]{3}$/.test(value),
  sort: (value) => SORT_COLUMNS.includes(value),
  order: (value) => value === "asc" || value === "desc",
  page: (value) => /^[1-9]\d{0,5}$/.test(value),
};

/** The open drawer lives in its own hook so that opening it never resets `page`. */
const DRAWER_DEFAULTS = { tx: "" };
const DRAWER_RULES = { tx: (value: string) => POSITIVE_ID.test(value) };

function rangeParams(period: PeriodState): Record<string, string> {
  const params: Record<string, string> = {};
  if (period.from !== null) params.from = period.from;
  if (period.to !== null) params.to = period.to;
  return params;
}

/** API query for the list: only the values that differ from the server defaults. */
export function listParams(
  state: TransactionUrlState,
  period: PeriodState,
): Record<string, string> {
  const params: Record<string, string> = {};
  const q = state.q.trim();
  if (q !== "") params.q = q;
  if (state.tab !== "all") params.tab = state.tab;
  if (state.accountId !== "") params.accountId = state.accountId;
  Object.assign(params, rangeParams(period));
  if (state.currency !== "") params.currency = state.currency;
  if (state.sort !== "date") params.sort = state.sort;
  if (state.order !== "desc") params.order = state.order;
  if (state.page !== "1") params.page = state.page;
  return params;
}

/** Date descending is the server default and reads as "no sort" (asc → desc → none). */
function toSortState(state: TransactionUrlState): SortState {
  if (state.sort === "date" && state.order === "desc") return null;
  return { columnId: state.sort, direction: state.order === "asc" ? "asc" : "desc" };
}

/**
 * Transactions (UX doc §4, list grammar): header with the count, the cash-flow aggregate whose
 * figures and bars filter the list, faceted tabs, search, account and period filters with chips,
 * the table with server-side sorting and pagination, and the detail drawer. Every piece of state
 * is in the URL.
 */
export function TransactionsPage() {
  const { t } = useTranslation();
  const { now, timeZone } = useFormatters();
  const today = toLocalDate(now(), timeZone);
  const [state, setState] = useUrlState(LIST_DEFAULTS, {
    validate: LIST_RULES,
    resetOnChange: ["page"],
  });
  const [drawer, setDrawer] = useUrlState(DRAWER_DEFAULTS, { validate: DRAWER_RULES });
  const period = readPeriod(state, today);
  const tab = state.tab as TransactionTab;
  const params = listParams(state, period);

  const list = useQuery({
    queryKey: queryKeys.transactions(params),
    queryFn: () => api.transactions(params),
    placeholderData: keepPreviousData,
  });
  const settings = useSettingsQuery();
  const connections = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.connections(),
    staleTime: 60_000,
  });

  const data = list.data;
  const fresh = data !== undefined && !list.isPlaceholderData ? data : undefined;
  const searchOrAccount = state.q.trim() !== "" || state.accountId !== "";
  const narrowed = searchOrAccount || tab !== "all";
  const isEmpty = fresh !== undefined && fresh.total === 0;

  const baseParams = { ...rangeParams(period), pageSize: PROBE_PAGE_SIZE };
  const base = useQuery({
    queryKey: queryKeys.transactions(baseParams),
    queryFn: () => api.transactions(baseParams),
    enabled: narrowed,
  });
  const needsAllTime = isEmpty && !narrowed && period.preset !== "all";
  const allTime = useQuery({
    queryKey: queryKeys.transactions(ALL_TIME_PARAMS),
    queryFn: () => api.transactions(ALL_TIME_PARAMS),
    enabled: needsAllTime,
  });

  const pageNumber = Number(state.page);
  useEffect(() => {
    // A page beyond the last one (rows removed since the link was made): go to the last page.
    if (fresh === undefined || fresh.items.length > 0 || fresh.total === 0) return;
    const last = Math.max(1, Math.ceil(fresh.total / PAGE_SIZE));
    if (pageNumber > last) setState({ page: String(last) });
  }, [fresh, pageNumber, setState]);

  const accounts = useMemo((): AccountOption[] => {
    const response = connections.data;
    if (!response) return [];
    return [
      ...response.connections.flatMap((connection) =>
        connection.accounts.map((account) => ({
          id: String(account.id),
          name: account.name,
          label: t("transactions.filters.accountOption", {
            name: account.name,
            bank: connection.bankName,
          }),
        })),
      ),
      ...response.removedAccounts.map((account) => ({
        id: String(account.id),
        name: account.name,
        label: t("transactions.filters.removedAccountOption", {
          name: account.name,
          bank: account.bankName,
        }),
      })),
    ];
  }, [connections.data, t]);

  let accountName: string | null = null;
  if (state.accountId !== "") {
    const selected = accounts.find((option) => option.id === state.accountId);
    if (selected) accountName = selected.name;
    else if (connections.isPending) accountName = t("common.loading");
    else accountName = t("transactions.filters.unknownAccount");
  }

  const results =
    narrowed && fresh !== undefined && base.data !== undefined
      ? { shown: fresh.total, total: base.data.total }
      : null;

  function clearFilters(): void {
    setState({ q: "", accountId: "", period: DEFAULT_PERIOD, from: "", to: "", tab: "all" });
  }

  function emptyState(): ReactNode {
    if (tab === "pending" && !searchOrAccount) {
      return (
        <EmptyState
          kind="positive"
          title={t("transactions.empty.pendingTitle")}
          description={t("transactions.empty.pendingDescription")}
        />
      );
    }
    if (narrowed) {
      return (
        <EmptyState
          kind="filter"
          title={t("transactions.empty.filterTitle")}
          description={t("transactions.empty.filterDescription")}
          action={
            <Button variant="secondary" onClick={clearFilters}>
              {t("table.clearFilters")}
            </Button>
          }
        />
      );
    }
    if (period.preset === "all" || allTime.data?.total === 0) {
      return (
        <EmptyState
          kind="empty"
          title={t("transactions.empty.trueTitle")}
          description={t("transactions.empty.trueDescription")}
          action={
            <Link to={buildPath("accounts")} className={PRIMARY_LINK_CLASS}>
              {t("transactions.empty.openAccounts")}
            </Link>
          }
        />
      );
    }
    return (
      <EmptyState
        kind="filter"
        title={t("transactions.empty.periodTitle")}
        description={t("transactions.empty.periodDescription")}
        action={
          <Button variant="secondary" onClick={() => setState({ period: "all", from: "", to: "" })}>
            {t("transactions.empty.showAllPeriods")}
          </Button>
        }
      />
    );
  }

  const tableLoading = fresh === undefined || (needsAllTime && allTime.isPending);
  const selectedDate =
    period.preset === "custom" && period.from !== null && period.from === period.to
      ? period.from
      : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("routes.transactions.title")}
        count={data?.total}
        subtitle={t("routes.transactions.description")}
      />
      {list.isError && data === undefined ? (
        <Card padding="lg" role="alert" className="flex flex-col items-start gap-3">
          <p className="font-display text-base font-bold text-fg">
            {t("transactions.error.title")}
          </p>
          <p className="text-sm text-muted">{t("transactions.error.description")}</p>
          <Button
            variant="secondary"
            icon={RotateCw}
            loading={list.isFetching}
            onClick={() => void list.refetch()}
          >
            {t("transactions.error.retry")}
          </Button>
        </Card>
      ) : (
        <>
          <CashFlowAggregate
            aggregate={data?.aggregate}
            tab={tab}
            onTabChange={(next) => setState({ tab: next })}
            onSelectBucket={(bucket) =>
              setState({ period: "custom", from: bucket.date, to: bucket.end })
            }
            selectedDate={selectedDate}
            onCurrencyChange={(currency) => setState({ currency })}
            highlightNegativeNet={settings.data?.values.highlightNegativeNet ?? true}
          />
          <Tabs
            ariaLabel={t("transactions.tabs.label")}
            value={tab}
            onChange={(id) => setState({ tab: id })}
            items={TABS.map((id) => ({
              id,
              label: t(`transactions.tabs.${id}`),
              count: data?.facets[id],
            }))}
          />
          <TransactionFilters
            q={state.q}
            accountId={state.accountId}
            period={period}
            today={today}
            accounts={accounts}
            accountName={accountName}
            results={results}
            onChange={setState}
            onClearAll={clearFilters}
          />
          <TransactionTable
            rows={data?.items}
            loading={tableLoading}
            sort={toSortState(state)}
            onSortChange={(next) =>
              setState(
                next === null
                  ? { sort: "date", order: "desc" }
                  : { sort: next.columnId, order: next.direction },
              )
            }
            onOpen={(row) => setDrawer({ tx: String(row.id) })}
            selectedId={drawer.tx === "" ? null : Number(drawer.tx)}
            today={today}
            empty={emptyState()}
          />
          {data !== undefined && data.total > 0 ? (
            <Pagination
              page={pageNumber}
              pageSize={PAGE_SIZE}
              total={data.total}
              onPageChange={(page) => setState({ page: String(page) })}
            />
          ) : null}
        </>
      )}
      <TransactionDrawer
        id={drawer.tx === "" ? null : Number(drawer.tx)}
        onClose={() => setDrawer({ tx: "" })}
      />
    </div>
  );
}
