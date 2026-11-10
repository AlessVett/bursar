import { naturalCollator } from "../../lib/search";

/** Countries Enable Banking covers, used when the bank status does not report its own list. */
export const CURATED_COUNTRIES: readonly string[] = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IS",
  "IE",
  "IT",
  "LV",
  "LI",
  "LT",
  "LU",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "GB",
];

/** Localised country name; falls back to the code itself for anything `Intl` cannot name. */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region", fallback: "code" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Select options for the given codes, upper-cased, de-duplicated and sorted by localised name. */
export function countryOptions(
  codes: readonly string[],
  locale: string,
): { value: string; label: string }[] {
  const collator = naturalCollator(locale);
  return [...new Set(codes.map((code) => code.toUpperCase()))]
    .map((code) => ({ value: code, label: countryName(code, locale) }))
    .sort((a, b) => collator.compare(a.label, b.label));
}
