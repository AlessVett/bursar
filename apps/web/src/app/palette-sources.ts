import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, type LucideIcon, Wallet } from "lucide-react";
import { createElement, type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { NetChip } from "../components/charts/NetChip";
import { useFormatters } from "../lib/format";
import { queryKeys } from "../lib/query-keys";
import { matchesQuery, normalizeForSearch } from "../lib/search";
import { useConnectionsQuery } from "../lib/use-connections";
import { accountDetailPath, buildPath, type RouteId, shippedRoutes } from "./routes";

export interface PaletteItem {
  id: string;
  group: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  to: string;
  /** Shown at the end of the row (Task 18: the account's 30-day `NetChip`). */
  trailing?: ReactNode;
}

export interface PaletteSource {
  id: string;
  /** Normalised query length below which the source contributes nothing. */
  minQueryLength: number;
  limit: number;
  /** A React hook: called on every render of the palette, in `PALETTE_SOURCES` order. */
  useItems(query: string): { items: PaletteItem[]; loading: boolean };
}

/** Routes that cannot be opened from the palette (they need a parameter or a bank redirect). */
const NOT_IN_PALETTE = new Set<RouteId>(["connectCallback"]);

const pagesSource: PaletteSource = {
  id: "pages",
  minQueryLength: 0,
  limit: 8,
  useItems(query) {
    // `t` changes identity on a language switch, so the memo follows the language.
    const { t } = useTranslation();
    const items = useMemo(() => {
      const group = t("palette.groups.pages");
      return shippedRoutes()
        .filter((def) => !def.path.includes(":") && !NOT_IN_PALETTE.has(def.id))
        .map((def) => ({
          def,
          title: t(def.titleKey),
          subtitle: t(def.descriptionKey),
          keywords: t(def.keywordsKey),
        }))
        .filter((entry) => matchesQuery([entry.title, entry.subtitle, entry.keywords], query))
        .map(
          (entry): PaletteItem => ({
            id: `page:${entry.def.id}`,
            group,
            title: entry.title,
            subtitle: entry.subtitle,
            icon: entry.def.icon,
            to: buildPath(entry.def.id),
          }),
        );
    }, [query, t]);
    return { items, loading: false };
  },
};

/**
 * Accounts by name, bank and the last four IBAN digits. They appear only once the query has two
 * characters (records are never listed for an empty query), and the connections are fetched only
 * then. The result opens the account's page, or the Accounts list while that page is not shipped.
 */
const accountsSource: PaletteSource = {
  id: "accounts",
  minQueryLength: 2,
  limit: 6,
  useItems(query) {
    const { t } = useTranslation();
    const enabled = normalizeForSearch(query).length >= 2;
    const connections = useConnectionsQuery({ enabled });
    const data = connections.data;
    const items = useMemo(() => {
      if (!enabled || !data) return [];
      const group = t("palette.groups.accounts");
      return data.connections.flatMap((connection) =>
        connection.accounts
          .filter((account) =>
            matchesQuery(
              [account.name, account.bankProduct ?? "", connection.bankName, account.last4 ?? ""],
              query,
            ),
          )
          .map(
            (account): PaletteItem => ({
              id: `account:${account.id}`,
              group,
              title: account.name,
              subtitle: connection.bankName,
              icon: Wallet,
              to: accountDetailPath(account.id) ?? buildPath("accounts"),
              trailing: createElement(NetChip, {
                netMinor: account.net30d.netMinor,
                currency: account.currency,
              }),
            }),
          ),
      );
    }, [data, enabled, query, t]);
    return { items, loading: enabled && connections.isPending };
  },
};

const SEARCH_DEBOUNCE_MS = 200;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Transactions by counterparty, through `GET /api/search` (accent-insensitive on the server).
 * The request waits for 200 ms of quiet typing; until the answer for the current query arrives the
 * source reports `loading`, so the palette does not flash its empty text. Amounts are not shown:
 * the palette ignores privacy mode, and a subtitle never carries financial data.
 */
export const transactionsSource: PaletteSource = {
  id: "transactions",
  minQueryLength: 2,
  limit: 6,
  useItems(query) {
    const { t } = useTranslation();
    const { localDate } = useFormatters();
    const debounced = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
    const active = query.length >= 2;
    const current = active && debounced === query;
    const result = useQuery({
      queryKey: queryKeys.search(debounced),
      queryFn: () => api.search(debounced),
      enabled: current,
      staleTime: 30_000,
    });
    const transactions = current ? result.data?.transactions : undefined;
    const items = useMemo(() => {
      if (!transactions) return [];
      const group = t("palette.groups.transactions");
      return transactions.map(
        (transaction): PaletteItem => ({
          id: `transaction:${transaction.id}`,
          group,
          title: transaction.counterparty,
          subtitle: t("palette.transactionSubtitle", {
            account: transaction.accountName,
            date: localDate(transaction.date),
          }),
          icon: ArrowLeftRight,
          to: buildPath("transactions", {}, { tx: String(transaction.id) }),
        }),
      );
    }, [transactions, t, localDate]);
    return { items, loading: active && (!current || result.isFetching) };
  },
};

/** Result sources in display order: pages, accounts (T18), transactions (T21). */
export const PALETTE_SOURCES: readonly PaletteSource[] = [
  pagesSource,
  accountsSource,
  transactionsSource,
];
