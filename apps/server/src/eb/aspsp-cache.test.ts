import { describe, expect, it, vi } from "vitest";
import { AspspCache } from "./aspsp-cache";
import type { EnableBankingApi } from "./client";
import { EnableBankingError } from "./errors";
import aspspsFixture from "./fixtures/aspsps.json";
import { type EbAspsp, ebAspspListSchema } from "./schemas";

const ASPSPS = ebAspspListSchema.parse(aspspsFixture).aspsps;
const DAY_MS = 86_400_000;

const notStubbed = () => Promise.reject(new Error("not stubbed"));

function stubApi(overrides: Partial<EnableBankingApi>): EnableBankingApi {
  return {
    getApplication: notStubbed,
    listAspsps: notStubbed,
    startAuthorization: notStubbed,
    createSession: notStubbed,
    getSession: notStubbed,
    deleteSession: notStubbed,
    getBalances: notStubbed,
    getTransactions: notStubbed,
    ...overrides,
  };
}

describe("AspspCache", () => {
  it("caches the list per country for 24 hours", async () => {
    let now = 1_000;
    const listAspsps = vi.fn(async (country: string) =>
      ASPSPS.map((aspsp) => ({ ...aspsp, country })),
    );
    const cache = new AspspCache(stubApi({ listAspsps }), () => now);
    expect(await cache.list("IT")).toHaveLength(4);
    await cache.list("IT");
    expect(listAspsps).toHaveBeenCalledTimes(1);
    await cache.list("FI");
    expect(listAspsps).toHaveBeenCalledTimes(2);
    now += DAY_MS;
    await cache.list("IT");
    expect(listAspsps).toHaveBeenCalledTimes(3);
  });

  it("shares one request between concurrent callers", async () => {
    let release: (value: EbAspsp[]) => void = () => {};
    const listAspsps = vi.fn(
      () =>
        new Promise<EbAspsp[]>((resolve) => {
          release = resolve;
        }),
    );
    const cache = new AspspCache(stubApi({ listAspsps }));
    const all = Promise.all([cache.list("IT"), cache.list("IT"), cache.list("IT")]);
    release(ASPSPS);
    const results = await all;
    expect(listAspsps).toHaveBeenCalledTimes(1);
    expect(results.map((list) => list.length)).toEqual([4, 4, 4]);
  });

  it("does not cache failures", async () => {
    const listAspsps = vi
      .fn<(country: string) => Promise<EbAspsp[]>>()
      .mockRejectedValueOnce(new EnableBankingError(500, "ASPSP_ERROR", "Bank unavailable"))
      .mockResolvedValueOnce(ASPSPS);
    const cache = new AspspCache(stubApi({ listAspsps }));
    await expect(cache.list("IT")).rejects.toBeInstanceOf(EnableBankingError);
    expect(await cache.list("IT")).toHaveLength(4);
    expect(listAspsps).toHaveBeenCalledTimes(2);
  });

  it("finds a bank by its exact name", async () => {
    const cache = new AspspCache(stubApi({ listAspsps: async () => ASPSPS }));
    expect((await cache.find("IT", "Banca Esempio"))?.maximum_consent_validity).toBe(7_776_000);
    expect(await cache.find("IT", "banca esempio")).toBeNull();
    expect(await cache.find("IT", "Unknown Bank")).toBeNull();
  });
});
