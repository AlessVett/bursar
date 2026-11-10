import type { AccountStatus } from "@bursar/shared";
import { describe, expect, it } from "vitest";
import { buildCashFlow, chooseBucket, defaultCurrency } from "./cashflow";

const base = { currency: "EUR", currencies: ["EUR"], currentBalanceMinor: null };

describe("chooseBucket", () => {
  it("uses days up to 92 days, both ends included", () => {
    expect(chooseBucket("2026-11-09", "2026-11-09")).toBe("day");
    expect(chooseBucket("2026-01-01", "2026-04-02")).toBe("day"); // 92 days
    expect(chooseBucket("2026-01-01", "2026-04-03")).toBe("week"); // 93 days
  });

  it("uses weeks up to 400 days and months beyond", () => {
    expect(chooseBucket("2026-01-01", "2027-02-04")).toBe("week"); // 400 days
    expect(chooseBucket("2026-01-01", "2027-02-05")).toBe("month"); // 401 days
  });
});

describe("defaultCurrency", () => {
  const account = (currency: string, status: AccountStatus = "active") => ({ currency, status });

  it("returns the currency of the most included accounts", () => {
    expect(defaultCurrency([account("USD"), account("EUR"), account("EUR")])).toBe("EUR");
  });

  it("breaks ties alphabetically", () => {
    expect(defaultCurrency([account("USD"), account("EUR")])).toBe("EUR");
    expect(defaultCurrency([account("GBP"), account("CHF"), account("USD")])).toBe("CHF");
  });

  it("counts unavailable accounts and ignores disabled and removed ones", () => {
    expect(
      defaultCurrency([
        account("USD", "unavailable"),
        account("EUR", "disabled"),
        account("EUR", "removed"),
        account("EUR", "disabled"),
      ]),
    ).toBe("USD");
  });

  it("returns null without an included account", () => {
    expect(defaultCurrency([])).toBeNull();
    expect(defaultCurrency([account("EUR", "disabled")])).toBeNull();
  });
});

describe("buildCashFlow", () => {
  it("returns one zero bucket per day, with no rows", () => {
    const result = buildCashFlow([], { ...base, from: "2026-11-01", to: "2026-11-03" });
    expect(result.bucket).toBe("day");
    expect(result.buckets.map((b) => b.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(result.buckets.every((b) => b.count === 0 && b.netMinor === 0)).toBe(true);
    expect(result.totals).toEqual({ inMinor: 0, outMinor: 0, netMinor: 0, count: 0 });
    expect(result.buckets.every((b) => b.balanceMinor === null)).toBe(true);
  });

  it("sums inflows and outflows (out as a positive magnitude) and zero-fills the gaps", () => {
    const result = buildCashFlow(
      [
        { date: "2026-11-01", amountMinor: 250_000, status: "booked" },
        { date: "2026-11-01", amountMinor: -1_250, status: "booked" },
        { date: "2026-11-01", amountMinor: -3_000, status: "pending" },
        { date: "2026-11-04", amountMinor: -400, status: "booked" },
        { date: "2026-10-31", amountMinor: -999, status: "booked" }, // before the period
        { date: "2026-11-06", amountMinor: -999, status: "booked" }, // after the period
      ],
      { ...base, from: "2026-11-01", to: "2026-11-05" },
    );
    expect(result.buckets).toEqual([
      {
        date: "2026-11-01",
        end: "2026-11-01",
        inMinor: 250_000,
        outMinor: 4_250,
        netMinor: 245_750,
        count: 3,
        balanceMinor: null,
      },
      {
        date: "2026-11-02",
        end: "2026-11-02",
        inMinor: 0,
        outMinor: 0,
        netMinor: 0,
        count: 0,
        balanceMinor: null,
      },
      {
        date: "2026-11-03",
        end: "2026-11-03",
        inMinor: 0,
        outMinor: 0,
        netMinor: 0,
        count: 0,
        balanceMinor: null,
      },
      {
        date: "2026-11-04",
        end: "2026-11-04",
        inMinor: 0,
        outMinor: 400,
        netMinor: -400,
        count: 1,
        balanceMinor: null,
      },
      {
        date: "2026-11-05",
        end: "2026-11-05",
        inMinor: 0,
        outMinor: 0,
        netMinor: 0,
        count: 0,
        balanceMinor: null,
      },
    ]);
    expect(result.totals).toEqual({
      inMinor: 250_000,
      outMinor: 4_650,
      netMinor: 245_350,
      count: 4,
    });
  });

  it("computes the running balance backwards from the end of the period, booked rows only", () => {
    const result = buildCashFlow(
      [
        { date: "2026-11-02", amountMinor: 10_000, status: "booked" },
        { date: "2026-11-03", amountMinor: -2_500, status: "booked" },
        { date: "2026-11-03", amountMinor: -700, status: "pending" },
      ],
      { ...base, from: "2026-11-01", to: "2026-11-04", currentBalanceMinor: 50_000 },
    );
    // End of 11-04: 50 000. 11-04 has no booked row, so the end of 11-03 is also 50 000.
    // Undoing 11-03 (-2 500) gives 52 500 at the end of 11-02, undoing 11-02 (+10 000) gives 42 500.
    expect(result.buckets.map((b) => b.balanceMinor)).toEqual([42_500, 52_500, 50_000, 50_000]);
  });

  it("allows a negative running balance", () => {
    const result = buildCashFlow([{ date: "2026-11-02", amountMinor: 5_000, status: "booked" }], {
      ...base,
      from: "2026-11-01",
      to: "2026-11-02",
      currentBalanceMinor: 1_000,
    });
    expect(result.buckets.map((b) => b.balanceMinor)).toEqual([-4_000, 1_000]);
  });

  it("buckets by ISO week across a year boundary and clips the first bucket", () => {
    const result = buildCashFlow(
      [
        { date: "2026-12-31", amountMinor: -5_000, status: "booked" },
        { date: "2027-01-01", amountMinor: 2_000, status: "booked" },
        { date: "2027-01-04", amountMinor: -100, status: "booked" },
      ],
      { ...base, from: "2026-12-02", to: "2027-03-14", currentBalanceMinor: 100_000 },
    );
    expect(result.bucket).toBe("week");
    const [first, , , , crossing, next] = result.buckets;
    expect(first).toMatchObject({ date: "2026-12-02", end: "2026-12-06" }); // Wed..Sun, clipped
    expect(crossing).toMatchObject({
      date: "2026-12-28",
      end: "2027-01-03",
      inMinor: 2_000,
      outMinor: 5_000,
      netMinor: -3_000,
      count: 2,
    });
    expect(next).toMatchObject({ date: "2027-01-04", end: "2027-01-10", outMinor: 100, count: 1 });
    expect(result.buckets.at(-1)).toMatchObject({ date: "2027-03-08", end: "2027-03-14" });
    expect(
      result.buckets.every(
        (b) => new Date(`${b.date}T00:00:00Z`) <= new Date(`${b.end}T00:00:00Z`),
      ),
    ).toBe(true);
    // The balance at the end of the crossing week is 100 000 minus the booked flows after it.
    expect(crossing?.balanceMinor).toBe(100_000 + 100);
  });

  it("buckets by month for long periods and clips the last bucket", () => {
    const result = buildCashFlow([{ date: "2026-02-15", amountMinor: 700, status: "booked" }], {
      ...base,
      from: "2025-01-15",
      to: "2026-06-10",
    });
    expect(result.bucket).toBe("month");
    expect(result.buckets[0]).toMatchObject({ date: "2025-01-15", end: "2025-01-31" });
    expect(result.buckets[1]).toMatchObject({ date: "2025-02-01", end: "2025-02-28" });
    expect(result.buckets.at(-1)).toMatchObject({ date: "2026-06-01", end: "2026-06-10" });
    expect(result.buckets).toHaveLength(18);
    expect(result.buckets.find((b) => b.date === "2026-02-01")).toMatchObject({
      end: "2026-02-28",
      inMinor: 700,
      count: 1,
    });
  });

  it("handles a leap-year February and a one-day period", () => {
    const month = buildCashFlow([], { ...base, from: "2023-12-01", to: "2025-03-31" });
    expect(month.buckets.find((b) => b.date === "2024-02-01")?.end).toBe("2024-02-29");
    const one = buildCashFlow([{ date: "2026-11-09", amountMinor: 1, status: "booked" }], {
      ...base,
      from: "2026-11-09",
      to: "2026-11-09",
    });
    expect(one.buckets).toHaveLength(1);
    expect(one.totals.count).toBe(1);
  });

  it("passes the currency fields through and rejects an inverted period", () => {
    const result = buildCashFlow([], {
      ...base,
      currency: "USD",
      currencies: ["EUR", "USD"],
      from: "2026-11-01",
      to: "2026-11-01",
    });
    expect(result.currency).toBe("USD");
    expect(result.currencies).toEqual(["EUR", "USD"]);
    expect(() => buildCashFlow([], { ...base, from: "2026-11-02", to: "2026-11-01" })).toThrow(
      RangeError,
    );
  });
});
