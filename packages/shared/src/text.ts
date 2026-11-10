/**
 * Search normalisation shared by the server's `search_text` column and the panel's search box:
 * lowercase, accents removed, whitespace collapsed and trimmed ("  Caffè   ÀB " becomes "caffe ab").
 * Lowercasing comes first so that characters whose lowercase form adds a combining mark
 * ("İ") are stripped as well.
 */
export function normalizeForSearch(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim();
}
