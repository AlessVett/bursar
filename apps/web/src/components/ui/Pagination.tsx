import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../../lib/format";
import { IconButton } from "./IconButton";

export interface PaginationProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange(page: number): void;
}

export function Pagination({ page, pageSize, total, onPageChange }: PaginationProps) {
  const { t } = useTranslation();
  const { locale } = useFormatters();
  if (total <= 0 || pageSize <= 0) return null;
  const pages = Math.ceil(total / pageSize);
  const current = Math.min(Math.max(1, page), pages);
  const number = new Intl.NumberFormat(locale);
  const from = (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);
  return (
    <nav
      aria-label={t("table.pagination")}
      className="flex flex-wrap items-center justify-between gap-2 px-1 py-3"
    >
      <p className="tabular text-[13px] text-muted">
        {t("table.range", {
          from: number.format(from),
          to: number.format(to),
          total: number.format(total),
        })}
      </p>
      {pages > 1 ? (
        <div className="flex items-center gap-1">
          <span className="tabular mr-2 text-[13px] text-muted">
            {t("table.pageOf", { page: number.format(current), pages: number.format(pages) })}
          </span>
          <IconButton
            label={t("table.previous")}
            icon={ChevronLeft}
            disabled={current <= 1}
            onClick={() => onPageChange(current - 1)}
          />
          <IconButton
            label={t("table.next")}
            icon={ChevronRight}
            disabled={current >= pages}
            onClick={() => onPageChange(current + 1)}
          />
        </div>
      ) : null}
    </nav>
  );
}
