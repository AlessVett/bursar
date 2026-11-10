import type { AspspListResponse, AspspSummary } from "@bursar/shared";
import type { UseQueryResult } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { bankLogoUrl } from "../../api";
import { Badge, Button, EmptyState, SearchInput } from "../../components/ui";
import { matchesQuery } from "../../lib/search";

/** Up to two initials of the bank name, for banks without a logo. */
export function bankInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

const MARK_SIZES = { sm: "size-8", md: "size-10" } as const;

/** The bank's logo through the server proxy, or its initials when there is none or it fails. */
export function BankMark({
  bank,
  size = "md",
}: {
  bank: Pick<AspspSummary, "name" | "country" | "hasLogo">;
  size?: keyof typeof MARK_SIZES;
}) {
  const [failed, setFailed] = useState(false);
  if (bank.hasLogo && !failed) {
    return (
      <img
        src={bankLogoUrl(bank.country, bank.name)}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={`${MARK_SIZES[size]} shrink-0 rounded-lg bg-surface-2 object-contain`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${MARK_SIZES[size]} inline-flex shrink-0 items-center justify-center rounded-lg bg-primary-50 text-sm font-semibold text-primary`}
    >
      {bankInitials(bank.name)}
    </span>
  );
}

const SKELETON_ROWS = [
  { id: "a", width: "w-full" },
  { id: "b", width: "w-11/12" },
  { id: "c", width: "w-full" },
  { id: "d", width: "w-10/12" },
  { id: "e", width: "w-full" },
] as const;

export interface BankStepProps {
  /** Localised name of the chosen country. */
  countryLabel: string;
  query: UseQueryResult<AspspListResponse>;
  onPick(bank: AspspSummary): void;
  onChangeCountry(): void;
}

export function BankStep({ countryLabel, query, onPick, onChangeCountry }: BankStepProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const banks = query.data?.aspsps;
  const visible = useMemo(() => {
    if (!banks) return [];
    return search.trim() === "" ? banks : banks.filter((bank) => matchesQuery(bank.name, search));
  }, [banks, search]);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-xl font-bold text-fg">{t("connect.bank.title")}</h2>
          <p className="mt-1 text-sm text-muted">
            {t("connect.bank.inCountry", { country: countryLabel })}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onChangeCountry}>
          {t("connect.bank.changeCountry")}
        </Button>
      </div>

      {query.isPending ? (
        <div aria-busy="true" className="space-y-2">
          <span className="sr-only">{t("connect.loading")}</span>
          {SKELETON_ROWS.map((row) => (
            <div
              key={row.id}
              className={`h-14 animate-pulse rounded-2xl bg-surface-2 ${row.width}`}
            />
          ))}
        </div>
      ) : query.isError ? (
        <EmptyState
          kind="state"
          title={t("connect.bank.listError.title")}
          description={t("connect.bank.listError.description")}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {t("connect.bank.listError.retry")}
            </Button>
          }
        />
      ) : (banks?.length ?? 0) === 0 ? (
        <EmptyState
          kind="empty"
          title={t("connect.bank.empty.title")}
          description={t("connect.bank.empty.description")}
          action={
            <Button variant="secondary" onClick={onChangeCountry}>
              {t("connect.bank.changeCountry")}
            </Button>
          }
        />
      ) : (
        <>
          <SearchInput
            value={search}
            onChange={setSearch}
            label={t("connect.bank.searchLabel")}
            placeholder={t("connect.bank.searchPlaceholder")}
          />
          <p aria-live="polite" className="text-[13px] text-muted">
            {t("connect.bank.results", { count: visible.length })}
          </p>
          {visible.length === 0 ? (
            <EmptyState
              kind="filter"
              title={t("connect.bank.noMatch.title", { query: search.trim() })}
              description={t("connect.bank.noMatch.description")}
              action={
                <Button variant="secondary" onClick={() => setSearch("")}>
                  {t("connect.bank.clearSearch")}
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-surface">
              {visible.map((bank) => (
                <li key={`${bank.country}:${bank.name}`}>
                  <button
                    type="button"
                    data-testid="bank-option"
                    onClick={() => onPick(bank)}
                    className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 max-sm:min-h-16"
                  >
                    <BankMark bank={bank} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-fg">{bank.name}</span>
                        {bank.beta ? (
                          <span title={t("connect.bank.betaHint")}>
                            <Badge tone="neutral">{t("connect.bank.beta")}</Badge>
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-[13px] text-muted">
                        {t("connect.bank.maxDays", { count: bank.maximumConsentDays })}
                      </span>
                    </span>
                    <ChevronRight aria-hidden size={16} className="shrink-0 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
