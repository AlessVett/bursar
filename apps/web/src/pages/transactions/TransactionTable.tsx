import { formatLocalDate, type LocalDate, type TransactionItem } from "@bursar/shared";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type Column, DataTable, Money, type SortState, StatusPill } from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { relativeDayLabel } from "./period";

export interface TransactionTableProps {
  /** `undefined` while the first response is on its way. */
  rows: TransactionItem[] | undefined;
  loading: boolean;
  sort: SortState;
  onSortChange(sort: SortState): void;
  onOpen(row: TransactionItem): void;
  selectedId: number | null;
  today: LocalDate;
  /** The empty state chosen by the page (filter-empty, true-empty, positive…). */
  empty: ReactNode;
}

function DayLabel({ date, today }: { date: LocalDate; today: LocalDate }) {
  const { locale } = useFormatters();
  return (
    <time
      dateTime={date}
      title={formatLocalDate(date, locale, { style: "long", weekday: true })}
      className="whitespace-nowrap"
    >
      {relativeDayLabel(date, today, locale)}
    </time>
  );
}

function SignedAmount({ row, className }: { row: TransactionItem; className: string }) {
  return (
    <Money
      minor={row.amountMinor}
      currency={row.currency}
      sign="always"
      tone="auto-flow"
      className={className}
    />
  );
}

/** Counterparty cell; below `sm` it is the whole row: name, pill and amount over date · account. */
function CounterpartyCell({ row, today }: { row: TransactionItem; today: LocalDate }) {
  const { t } = useTranslation();
  const name = row.counterparty ?? row.description;
  return (
    <div className="max-w-[calc(100vw_-_5rem)] min-w-0 py-1.5 sm:max-w-[16rem] xl:max-w-[22rem]">
      <div className="flex min-w-0 items-center gap-2">
        <span
          title={name ?? undefined}
          className={`min-w-0 flex-1 truncate font-medium ${name ? "text-fg" : "text-muted"}`}
        >
          {name ?? t("transactions.noCounterparty")}
        </span>
        {row.status === "pending" ? (
          <StatusPill tone="info" label={t("transactions.pending")} className="shrink-0" />
        ) : null}
        <SignedAmount row={row} className="shrink-0 font-semibold whitespace-nowrap sm:hidden" />
      </div>
      <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted sm:hidden">
        <DayLabel date={row.date} today={today} />
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">{row.accountName}</span>
      </p>
    </div>
  );
}

/**
 * The transactions table: relative day (absolute date in `title`), counterparty with the pending
 * pill, description, account and the signed amount in its flow tone. Sorting is server-side.
 */
export function TransactionTable({
  rows,
  loading,
  sort,
  onSortChange,
  onOpen,
  selectedId,
  today,
  empty,
}: TransactionTableProps) {
  const { t } = useTranslation();
  const columns: Column<TransactionItem>[] = [
    {
      id: "date",
      header: t("transactions.table.date"),
      sortable: true,
      hideBelow: "sm",
      className: "w-32",
      cell: (row) => <DayLabel date={row.date} today={today} />,
    },
    {
      id: "counterparty",
      header: t("transactions.table.counterparty"),
      sortable: true,
      cell: (row) => <CounterpartyCell row={row} today={today} />,
    },
    {
      id: "description",
      header: t("transactions.table.description"),
      hideBelow: "lg",
      cell: (row) => (
        <span
          title={row.description ?? undefined}
          className="block max-w-[18rem] truncate text-muted"
        >
          {row.description ?? ""}
        </span>
      ),
    },
    {
      id: "account",
      header: t("transactions.table.account"),
      hideBelow: "md",
      cell: (row) => (
        <span title={row.accountName} className="block max-w-[12rem] truncate text-muted">
          {row.accountName}
        </span>
      ),
    },
    {
      id: "amount",
      header: t("transactions.table.amount"),
      sortable: true,
      align: "end",
      hideBelow: "sm",
      cell: (row) => <SignedAmount row={row} className="font-semibold whitespace-nowrap" />,
    },
  ];
  return (
    <DataTable
      caption={t("transactions.table.caption")}
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      loading={loading}
      skeletonRows={10}
      sort={sort}
      onSortChange={onSortChange}
      onRowClick={onOpen}
      selectedKey={selectedId}
      empty={empty}
    />
  );
}
