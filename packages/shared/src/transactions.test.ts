import { describe, expect, it } from "vitest";
import { searchQuerySchema } from "./search";
import {
  cashflowQuerySchema,
  PERIOD_BOUNDS,
  transactionQuerySchema,
  transactionTabSchema,
} from "./transactions";

describe("transactionQuerySchema", () => {
  it("fills every default from an empty query", () => {
    expect(transactionQuerySchema.parse({})).toEqual({
      tab: "all",
      page: 1,
      pageSize: 20,
      sort: "date",
      order: "desc",
    });
  });

  it("coerces numbers from text and upper-cases the currency", () => {
    expect(
      transactionQuerySchema.parse({
        q: "  caffè  ",
        accountId: "7",
        tab: "in",
        from: "2026-01-01",
        to: "2026-01-31",
        currency: "eur",
        page: "3",
        pageSize: "50",
        sort: "amount",
        order: "asc",
      }),
    ).toEqual({
      q: "caffè",
      accountId: 7,
      tab: "in",
      from: "2026-01-01",
      to: "2026-01-31",
      currency: "EUR",
      page: 3,
      pageSize: 50,
      sort: "amount",
      order: "asc",
    });
  });

  it("treats a blank search as absent", () => {
    expect(transactionQuerySchema.parse({ q: "   " }).q).toBeUndefined();
  });

  it("accepts a period with equal ends and rejects an inverted one", () => {
    expect(transactionQuerySchema.safeParse({ from: "2026-02-01", to: "2026-02-01" }).success).toBe(
      true,
    );
    const inverted = transactionQuerySchema.safeParse({ from: "2026-02-02", to: "2026-02-01" });
    expect(inverted.success).toBe(false);
    expect(transactionQuerySchema.safeParse({ from: "2026-02-02" }).success).toBe(true);
    expect(transactionQuerySchema.safeParse({ to: "2026-02-01" }).success).toBe(true);
  });

  it.each([
    ["page zero", { page: "0" }],
    ["fractional page", { page: "1.5" }],
    ["unsupported page size", { pageSize: "15" }],
    ["unknown tab", { tab: "refunds" }],
    ["unknown sort", { sort: "category" }],
    ["unknown order", { order: "up" }],
    ["impossible date", { from: "2026-02-30" }],
    ["badly formed date", { to: "01/02/2026" }],
    ["non-numeric account", { accountId: "abc" }],
    ["zero account", { accountId: "0" }],
    ["empty account", { accountId: "" }],
    ["long search", { q: "x".repeat(101) }],
    ["bad currency", { currency: "EURO" }],
    ["year typed digit by digit", { from: "0002-10-12" }],
    ["three-digit year", { to: "0202-10-12" }],
    ["date before 1970", { from: "1969-12-31" }],
    ["date after 2099", { to: "2100-01-01" }],
  ])("rejects %s", (_name, query) => {
    expect(transactionQuerySchema.safeParse(query).success).toBe(false);
  });

  it("accepts the period bounds themselves", () => {
    expect(PERIOD_BOUNDS).toEqual({ min: "1970-01-01", max: "2099-12-31" });
    expect(
      transactionQuerySchema.safeParse({ from: PERIOD_BOUNDS.min, to: PERIOD_BOUNDS.max }).success,
    ).toBe(true);
  });
});

describe("cashflowQuerySchema", () => {
  it("accepts an empty query", () => {
    expect(cashflowQuerySchema.parse({})).toEqual({});
  });

  it("coerces the account and normalises the currency", () => {
    expect(
      cashflowQuerySchema.parse({ accountId: "2", currency: "usd", from: "2026-03-01" }),
    ).toEqual({ accountId: 2, currency: "USD", from: "2026-03-01" });
  });

  it("rejects an inverted period and a bad account", () => {
    expect(cashflowQuerySchema.safeParse({ from: "2026-03-02", to: "2026-03-01" }).success).toBe(
      false,
    );
    expect(cashflowQuerySchema.safeParse({ accountId: "-1" }).success).toBe(false);
  });

  it("rejects a date outside the period bounds", () => {
    expect(cashflowQuerySchema.safeParse({ from: "0020-10-12" }).success).toBe(false);
    expect(cashflowQuerySchema.safeParse({ to: "2100-01-01" }).success).toBe(false);
  });
});

describe("transactionTabSchema", () => {
  it("lists the four tabs", () => {
    expect(transactionTabSchema.options).toEqual(["all", "in", "out", "pending"]);
  });
});

describe("searchQuerySchema", () => {
  it("trims and requires two characters", () => {
    expect(searchQuerySchema.parse({ q: "  ab " })).toEqual({ q: "ab" });
    expect(searchQuerySchema.safeParse({ q: "a" }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: "  a  " }).success).toBe(false);
    expect(searchQuerySchema.safeParse({}).success).toBe(false);
  });

  it("limits the length to 100 characters", () => {
    expect(searchQuerySchema.safeParse({ q: "x".repeat(100) }).success).toBe(true);
    expect(searchQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
  });
});
