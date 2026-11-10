import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "./cn";
import { SkeletonRows } from "./SkeletonRows";

export interface Column<Row> {
  id: string;
  header: string;
  cell(row: Row): ReactNode;
  sortable?: boolean;
  align?: "start" | "end";
  /** Hides the column below this breakpoint. */
  hideBelow?: "sm" | "md" | "lg";
  className?: string;
}

export type SortState = { columnId: string; direction: "asc" | "desc" } | null;

/** Header click cycle: ascending, then descending, then unsorted. */
export function nextSort(current: SortState, columnId: string): SortState {
  if (!current || current.columnId !== columnId) return { columnId, direction: "asc" };
  if (current.direction === "asc") return { columnId, direction: "desc" };
  return null;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  /** `undefined` while the first response is on its way. */
  rows: Row[] | undefined;
  getRowKey(row: Row): string | number;
  loading?: boolean;
  skeletonRows?: number;
  sort?: SortState;
  onSortChange?(sort: SortState): void;
  onRowClick?(row: Row): void;
  selectedKey?: string | number | null;
  /** Shown instead of the body when `rows` is empty. */
  empty?: ReactNode;
  /** Accessible table name (visually hidden). */
  caption: string;
}

const HIDE_BELOW = {
  sm: "max-sm:hidden",
  md: "max-md:hidden",
  lg: "max-lg:hidden",
} as const;

const INTERACTIVE = "button, a, input, select, textarea, label, summary, [role='button']";

function columnClass<Row>(column: Column<Row>): string {
  return cn(
    column.align === "end" ? "text-end" : "text-start",
    column.hideBelow && HIDE_BELOW[column.hideBelow],
    column.className,
  );
}

export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  loading = false,
  skeletonRows = 8,
  sort = null,
  onSortChange,
  onRowClick,
  selectedKey = null,
  empty,
  caption,
}: DataTableProps<Row>) {
  const { t } = useTranslation();
  const showSkeleton = loading || rows === undefined;

  function onClick(event: MouseEvent<HTMLTableRowElement>, row: Row): void {
    const target = event.target;
    if (target instanceof Element) {
      const inner = target.closest(INTERACTIVE);
      if (inner && event.currentTarget.contains(inner)) return;
    }
    onRowClick?.(row);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: Row): void {
    if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      onRowClick?.(row);
    }
  }

  return (
    <div className="rounded-2xl border border-subtle bg-surface shadow-sm">
      <div className="overflow-x-auto rounded-2xl">
        <table className="w-full border-collapse text-[13px]" aria-busy={showSkeleton || undefined}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="text-xs font-semibold text-muted">
              {columns.map((column) => {
                const active = sort?.columnId === column.id ? sort.direction : null;
                const Icon =
                  active === "asc" ? ArrowUp : active === "desc" ? ArrowDown : ChevronsUpDown;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={
                      active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined
                    }
                    className={cn("px-4 py-2.5 font-semibold", columnClass(column))}
                  >
                    {column.sortable && onSortChange ? (
                      <button
                        type="button"
                        title={t("table.sortBy", { column: column.header })}
                        onClick={() => onSortChange(nextSort(sort, column.id))}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md hover:text-fg max-sm:min-h-11",
                          active && "text-fg",
                        )}
                      >
                        {column.header}
                        <Icon aria-hidden size={13} strokeWidth={2} />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {showSkeleton ? (
              <SkeletonRows
                rows={skeletonRows}
                columns={columns.length}
                cellClassNames={columns.map((column) =>
                  column.hideBelow ? HIDE_BELOW[column.hideBelow] : undefined,
                )}
              />
            ) : rows.length === 0 ? (
              empty ? (
                <tr className="border-t border-subtle">
                  <td colSpan={columns.length}>{empty}</td>
                </tr>
              ) : null
            ) : (
              rows.map((row) => {
                const key = getRowKey(row);
                const clickable = onRowClick !== undefined;
                return (
                  <tr
                    key={key}
                    data-selected={selectedKey === key || undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? (event) => onClick(event, row) : undefined}
                    onKeyDown={clickable ? (event) => onKeyDown(event, row) : undefined}
                    style={{ height: "var(--row-height)" }}
                    className={cn(
                      "border-t border-subtle",
                      clickable && "cursor-pointer hover:bg-surface-2",
                      selectedKey === key && "bg-primary-50",
                    )}
                  >
                    {columns.map((column) => (
                      <td key={column.id} className={cn("px-4 py-1", columnClass(column))}>
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
