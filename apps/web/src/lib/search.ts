import { normalizeForSearch } from "@bursar/shared";

export { normalizeForSearch };

/**
 * Accent- and case-insensitive match. Every whitespace-separated word of `query` must appear
 * somewhere in the haystack (a string, or the parts of a row joined together). An empty query
 * matches everything.
 */
export function matchesQuery(haystack: string | readonly string[], query: string): boolean {
  const words = normalizeForSearch(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const text = normalizeForSearch(typeof haystack === "string" ? haystack : haystack.join(" "));
  return words.every((word) => text.includes(word));
}

/** Natural-order collator: "Account 2" sorts before "Account 10", case and accents ignored. */
export function naturalCollator(locale: string): Intl.Collator {
  return new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
}
