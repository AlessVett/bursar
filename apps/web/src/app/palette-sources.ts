import type { LucideIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { matchesQuery } from "../lib/search";
import { buildPath, type RouteId, shippedRoutes } from "./routes";

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

/** Result sources in display order. Later tasks append accounts (T18) and transactions (T21). */
export const PALETTE_SOURCES: readonly PaletteSource[] = [pagesSource];
