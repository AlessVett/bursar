import { addDays, type LocalDate } from "@bursar/shared";
import { SlidersHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FilterChips,
  type FilterChipsProps,
  SearchInput,
  Select,
  TextInput,
} from "../../components/ui";
import { useFormatters } from "../../lib/format";
import { DEFAULT_PERIOD, isPeriodDate, PERIOD_PRESETS, type PeriodState } from "./period";

export interface AccountOption {
  /** Account id as written in the URL. */
  id: string;
  /** Display name for the chip. */
  name: string;
  /** Option text: name and bank, disconnected accounts labelled. */
  label: string;
}

type FilterKey = "q" | "accountId" | "currency" | "period" | "from" | "to";

export interface TransactionFiltersProps {
  q: string;
  accountId: string;
  /** ISO code of the currency filter (set from the aggregate's switch); "" or absent for none. */
  currency?: string;
  period: PeriodState;
  today: LocalDate;
  accounts: AccountOption[];
  /** Name for the account chip (never an id), null without an account filter. */
  accountName: string | null;
  /** "12 results of 840", shown while search, account or tab narrow the list. */
  results: { shown: number; total: number } | null;
  onChange(patch: Partial<Record<FilterKey, string>>): void;
  onClearAll(): void;
}

/**
 * A custom period bound. The browser reports a year typed digit by digit as 0002, 0020 and 0202
 * before 2025: such a value stays in the field (so typing goes on) and is written to the URL only
 * once it is a period date, or when it is cleared. Leaving the field with an unfinished value shows
 * the date in use again.
 */
function PeriodDateInput({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onCommit(value: string): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <TextInput
      type="date"
      label={label}
      value={draft ?? value}
      min={min}
      max={max}
      onChange={(event) => {
        const next = event.target.value;
        if (next === "" || isPeriodDate(next)) {
          setDraft(null);
          onCommit(next);
        } else {
          setDraft(next);
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/**
 * Search, account and period filters with their chips and the results line. Below `sm` the
 * account and period controls live in a panel opened by the "Filters" button.
 */
export function TransactionFilters({
  q,
  accountId,
  currency = "",
  period,
  today,
  accounts,
  accountName,
  results,
  onChange,
  onClearAll,
}: TransactionFiltersProps) {
  const { t } = useTranslation();
  const { locale, localDate } = useFormatters();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  function periodLabel(): string {
    const { preset, from, to } = period;
    if (preset !== "custom") return t(`transactions.periods.${preset}`);
    if (from !== null && to !== null) {
      return from === to ? localDate(from) : `${localDate(from)} – ${localDate(to)}`;
    }
    if (from !== null) return t("transactions.chips.rangeFrom", { date: localDate(from) });
    if (to !== null) return t("transactions.chips.rangeTo", { date: localDate(to) });
    return t("transactions.periods.custom");
  }

  const query = q.trim();
  const chips: FilterChipsProps["chips"] = [];
  if (query !== "") {
    chips.push({
      id: "q",
      label: t("transactions.chips.search", { q: query }),
      onRemove: () => onChange({ q: "" }),
    });
  }
  if (accountId !== "") {
    chips.push({
      id: "account",
      label: t("transactions.chips.account", {
        name: accountName ?? t("transactions.filters.unknownAccount"),
      }),
      onRemove: () => onChange({ accountId: "" }),
    });
  }
  if (currency !== "") {
    chips.push({
      id: "currency",
      label: t("transactions.chips.currency", { currency }),
      onRemove: () => onChange({ currency: "" }),
    });
  }
  if (period.preset !== DEFAULT_PERIOD) {
    chips.push({
      id: "period",
      label: t("transactions.chips.period", { label: periodLabel() }),
      onRemove: () => onChange({ period: DEFAULT_PERIOD, from: "", to: "" }),
    });
  }
  const panelFilters = (accountId !== "" ? 1 : 0) + (period.preset !== DEFAULT_PERIOD ? 1 : 0);

  const accountOptions = [
    { value: "", label: t("transactions.filters.allAccounts") },
    ...accounts.map((option) => ({ value: option.id, label: option.label })),
  ];
  if (accountId !== "" && !accounts.some((option) => option.id === accountId)) {
    accountOptions.push({
      value: accountId,
      label: accountName ?? t("transactions.filters.unknownAccount"),
    });
  }
  const periodOptions = PERIOD_PRESETS.map((preset) => ({
    value: preset,
    label: t(`transactions.periods.${preset}`),
  }));

  function changePeriod(value: string): void {
    if (value === "custom") {
      // Start the custom range from what is on screen, so switching loses nothing.
      onChange({
        period: "custom",
        from: period.from ?? addDays(today, -29),
        to: period.to ?? today,
      });
    } else {
      onChange({ period: value, from: "", to: "" });
    }
  }

  const number = new Intl.NumberFormat(locale);

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <SearchInput
            value={q}
            onChange={(value) => onChange({ q: value })}
            label={t("transactions.filters.searchLabel")}
            placeholder={t("transactions.filters.searchPlaceholder")}
          />
        </div>
        <Button
          variant="secondary"
          icon={SlidersHorizontal}
          className="sm:hidden"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          {panelFilters > 0
            ? t("transactions.filters.toggleCount", { active: panelFilters })
            : t("transactions.filters.toggle")}
        </Button>
      </div>
      <div
        id={panelId}
        className={`grid gap-x-3 sm:grid-cols-2 lg:grid-cols-4 ${open ? "" : "max-sm:hidden"}`}
      >
        <Select
          label={t("transactions.filters.account")}
          value={accountId}
          options={accountOptions}
          onChange={(event) => onChange({ accountId: event.target.value })}
        />
        <Select
          label={t("transactions.filters.period")}
          value={period.preset}
          options={periodOptions}
          onChange={(event) => changePeriod(event.target.value)}
        />
        {period.preset === "custom" ? (
          <>
            <PeriodDateInput
              label={t("transactions.filters.from")}
              value={period.from ?? ""}
              max={period.to ?? undefined}
              onCommit={(from) => onChange({ period: "custom", from, to: period.to ?? "" })}
            />
            <PeriodDateInput
              label={t("transactions.filters.to")}
              value={period.to ?? ""}
              min={period.from ?? undefined}
              onCommit={(to) => onChange({ period: "custom", from: period.from ?? "", to })}
            />
          </>
        ) : null}
      </div>
      <FilterChips chips={chips} onClearAll={onClearAll} />
      {results ? (
        <p aria-live="polite" className="tabular text-[13px] text-muted">
          {t("transactions.results", {
            count: results.shown,
            shown: number.format(results.shown),
            total: number.format(results.total),
          })}
        </p>
      ) : null}
    </div>
  );
}
