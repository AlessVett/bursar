import { cn } from "./cn";

export interface SkeletonRowsProps {
  rows: number;
  columns: number;
  /** Optional classes per column, so columns hidden on small screens stay hidden here too. */
  cellClassNames?: readonly (string | undefined)[];
}

const WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5", "w-3/5"] as const;

/** Table rows of varied widths: the loading state of a table. Never a spinner over a table. */
export function SkeletonRows({ rows, columns, cellClassNames }: SkeletonRowsProps) {
  return Array.from({ length: rows }, (_, row) => (
    <tr
      // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
      key={row}
      aria-hidden
      data-skeleton-row
      className="border-t border-subtle"
      style={{ height: "var(--row-height)" }}
    >
      {Array.from({ length: columns }, (_, column) => (
        <td
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells have no identity
          key={column}
          className={cn("px-4", cellClassNames?.[column])}
        >
          <div
            className={cn(
              "h-3 animate-pulse rounded bg-surface-2",
              WIDTHS[(row * 5 + column * 3) % WIDTHS.length],
            )}
          />
        </td>
      ))}
    </tr>
  ));
}
