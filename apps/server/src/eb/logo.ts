export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_TIMEOUT_MS = 10_000;
export const LOGO_CACHE_ENTRIES = 200;
export const LOGO_CACHE_TTL_MS = 24 * 3_600_000;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

interface CachedLogo {
  body: Buffer;
  contentType: string;
  expiresAt: number;
}

/** Least recently used first (Map keeps insertion order; a hit is re-inserted at the end). */
const cache = new Map<string, CachedLogo>();

/** For tests: forget every cached logo. */
export function clearLogoCache(): void {
  cache.clear();
}

function httpsUrl(value: string, base?: URL): URL | null {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}

async function readCapped(response: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function remember(url: string, body: Buffer, contentType: string, now: number): void {
  cache.set(url, { body, contentType, expiresAt: now + LOGO_CACHE_TTL_MS });
  while (cache.size > LOGO_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Fetches a bank logo for the panel (the CSP allows only same-origin images). The URL must come
 * from Enable Banking's ASPSP data, never from a client. https only, also on redirects; image types
 * only; at most 256 KiB, enforced while reading. Returns null on any failure.
 */
export async function fetchLogo(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ body: Buffer; contentType: string } | null> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    if (hit.expiresAt > now) {
      cache.set(url, hit);
      return { body: hit.body, contentType: hit.contentType };
    }
  }
  const first = httpsUrl(url);
  if (!first) return null;
  let target = first;
  try {
    const signal = AbortSignal.timeout(LOGO_TIMEOUT_MS);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(target.href, {
        redirect: "manual",
        signal,
        headers: { accept: "image/*" },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const next = httpsUrl(response.headers.get("location") ?? "", target);
        if (!next) return null;
        target = next;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return null;
      }
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (!contentType || !IMAGE_TYPES.has(contentType)) {
        await response.body?.cancel();
        return null;
      }
      const body = await readCapped(response, LOGO_MAX_BYTES);
      if (!body || body.length === 0) return null;
      remember(url, body, contentType, now);
      return { body, contentType };
    }
    return null;
  } catch {
    return null;
  }
}
