import type { LocalDate, TransactionItem } from "@bursar/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button, EmptyState, InlineEmpty, Money, StatusPill } from "../../components/ui";
import { type Column, DataTable } from "../../components/ui/DataTable";
import { useFormatters } from "../../lib/format";
import { queryKeys } from "../../lib/query-keys";

const PAGE_SIZE = 20;

/** A booking date: "Yesterday", "3 days ago" within 45 days, the date beyond; the long date in `title`. */
function TransactionDate({ date }: { date: LocalDate }) {
  const { localDate, relativeDay } = useFormatters();
  return (
    <time dateTime={date} title={localDate(date, "long")}>
      {relativeDay(date)}
    </time>
  );
}

/**
 * The latest 20 transactions of the account. The link to the full list is added by the task that
 * ships the Transactions page.
 */
export function TransactionsTab({ accountId }: { accountId: number }) {
  const { t } = useTranslation();
  const params = { accountId: String(accountId), pageSize: String(PAGE_SIZE) };
  const query = useQuery({
    queryKey: queryKeys.transactions(params),
    queryFn: () => api.transactions(params),
  });

  if (query.isError) {
    return (
      <EmptyState
        kind="state"
        icon={TriangleAlert}
        title={t("account.transactions.errorTitle")}
        description={t("account.transactions.errorDescription")}
        action={
          <Button variant="secondary" onClick={() => query.refetch()}>
            {t("account.retry")}
          </Button>
        }
      />
    );
  }

  const columns: Column<TransactionItem>[] = [
    {
      id: "date",
      header: t("account.transactions.date"),
      cell: (row) => <TransactionDate date={row.date} />,
      className: "whitespace-nowrap",
    },
    {
      id: "counterparty",
      header: t("account.transactions.counterparty"),
      className: "w-full max-w-0 md:w-auto md:max-w-xs",
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium text-fg">{row.counterparty ?? "—"}</span>
          {row.description ? (
            <span className="truncate text-xs text-muted md:hidden">{row.description}</span>
          ) : null}
          {row.status === "pending" ? (
            <span>
              <StatusPill tone="neutral" label={t("account.transactions.pending")} />
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "description",
      header: t("account.transactions.description"),
      cell: (row) => <span className="line-clamp-2 text-muted">{row.description ?? "—"}</span>,
      hideBelow: "md",
    },
    {
      id: "amount",
      header: t("account.transactions.amount"),
      cell: (row) => (
        <Money minor={row.amountMinor} currency={row.currency} tone="auto-flow" sign="always" />
      ),
      align: "end",
      className: "whitespace-nowrap",
    },
  ];

  const total = query.data?.total ?? 0;
  const shown = query.data?.items.length ?? 0;

  return (
    <div className="space-y-3">
      <DataTable
        columns={columns}
        rows={query.data?.items}
        loading={query.isPending}
        skeletonRows={6}
        getRowKey={(row) => row.id}
        caption={t("account.transactions.caption")}
        empty={
          <InlineEmpty
            icon={ArrowLeftRight}
            title={t("account.transactions.emptyTitle")}
            description={t("account.transactions.emptyDescription")}
          />
        }
      />
      {total > shown ? (
        <p className="text-xs text-muted">
          {t("account.transactions.showingLatest", { shown, count: total })}
        </p>
      ) : null}
    </div>
  );
}
