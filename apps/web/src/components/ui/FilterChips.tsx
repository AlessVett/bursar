import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface FilterChip {
  id: string;
  label: string;
  onRemove(): void;
}

export interface FilterChipsProps {
  chips: FilterChip[];
  onClearAll(): void;
  /** Optional text before the chips, for example "3 filters". */
  summary?: string;
}

export function FilterChips({ chips, onClearAll, summary }: FilterChipsProps) {
  const { t } = useTranslation();
  if (chips.length === 0) return null;
  return (
    <ul aria-label={t("table.activeFilters")} className="flex flex-wrap items-center gap-2">
      {summary ? <li className="text-[13px] text-muted">{summary}</li> : null}
      {chips.map((chip) => (
        <li key={chip.id}>
          <span className="inline-flex items-center gap-1 rounded-full bg-primary-50 py-1 pr-1 pl-3 text-[13px] text-primary">
            {chip.label}
            <button
              type="button"
              aria-label={t("table.removeFilter", { label: chip.label })}
              onClick={chip.onRemove}
              className="inline-flex size-5 items-center justify-center rounded-full hover:bg-surface-2 max-sm:size-8"
            >
              <X aria-hidden size={13} strokeWidth={2} />
            </button>
          </span>
        </li>
      ))}
      <li>
        <button
          type="button"
          onClick={onClearAll}
          className="rounded-lg px-2 py-1 text-[13px] font-medium text-primary underline-offset-2 hover:underline max-sm:min-h-11"
        >
          {t("table.clearFilters")}
        </button>
      </li>
    </ul>
  );
}
