import type { EnableBankingApi } from "./client";
import type { EbAspsp } from "./schemas";

export const ASPSP_CACHE_TTL_MS = 24 * 3_600_000;

/** Bank lists per country, kept for a day; failures are not cached. */
export class AspspCache {
  private readonly entries = new Map<string, { fetchedAt: number; aspsps: EbAspsp[] }>();
  private readonly inflight = new Map<string, Promise<EbAspsp[]>>();

  constructor(
    private readonly api: EnableBankingApi,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = ASPSP_CACHE_TTL_MS,
  ) {}

  async list(country: string): Promise<EbAspsp[]> {
    const key = country.toUpperCase();
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.fetchedAt < this.ttlMs) return entry.aspsps;
    const running = this.inflight.get(key);
    if (running) return running;
    const request = this.api
      .listAspsps(key)
      .then((aspsps) => {
        this.entries.set(key, { fetchedAt: this.now(), aspsps });
        return aspsps;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, request);
    return request;
  }

  async find(country: string, name: string): Promise<EbAspsp | null> {
    return (await this.list(country)).find((aspsp) => aspsp.name === name) ?? null;
  }
}
