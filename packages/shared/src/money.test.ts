import { describe, expect, it } from "vitest";
import {
  currencyMinorDigits,
  formatMoney,
  MASKED_AMOUNT,
  MoneyParseError,
  minorToDecimalString,
  parseDecimalToMinor,
  sumMinor,
} from "./money";

const NBSP = " ";

describe("currencyMinorDigits", () => {
  it("reads the minor digits from Intl", () => {
    expect(currencyMinorDigits("EUR")).toBe(2);
    expect(currencyMinorDigits("USD")).toBe(2);
    expect(currencyMinorDigits("JPY")).toBe(0);
    expect(currencyMinorDigits("BHD")).toBe(3);
    expect(currencyMinorDigits("KWD")).toBe(3);
  });

  it("accepts lowercase codes and rejects malformed ones", () => {
    expect(currencyMinorDigits("eur")).toBe(2);
    expect(() => currencyMinorDigits("EURO")).toThrow(RangeError);
    expect(() => currencyMinorDigits("12")).toThrow(RangeError);
    expect(() => currencyMinorDigits("")).toThrow(RangeError);
  });
});

describe("parseDecimalToMinor", () => {
  it("parses the plain decimal forms providers send", () => {
    expect(parseDecimalToMinor("12", "EUR")).toBe(1200);
    expect(parseDecimalToMinor("12.3", "EUR")).toBe(1230);
    expect(parseDecimalToMinor("12.30", "EUR")).toBe(1230);
    expect(parseDecimalToMinor("-0.5", "EUR")).toBe(-50);
    expect(parseDecimalToMinor("+7.00", "EUR")).toBe(700);
    expect(parseDecimalToMinor("  42.10\n", "EUR")).toBe(4210);
    expect(parseDecimalToMinor("007.50", "EUR")).toBe(750);
    expect(parseDecimalToMinor("0", "EUR")).toBe(0);
  });

  it("is exact where floating point is not", () => {
    // 4.35 * 100 === 434.99999999999994 and 0.29 * 100 === 28.999999999999996 in doubles.
    expect(parseDecimalToMinor("4.35", "EUR")).toBe(435);
    expect(parseDecimalToMinor("0.29", "EUR")).toBe(29);
    expect(parseDecimalToMinor("1.15", "EUR")).toBe(115);
    expect(parseDecimalToMinor("0.07", "EUR")).toBe(7);
  });

  it("uses the minor digits of the currency", () => {
    expect(parseDecimalToMinor("500", "JPY")).toBe(500);
    expect(parseDecimalToMinor("500.0", "JPY")).toBe(500);
    expect(parseDecimalToMinor("-1.234", "BHD")).toBe(-1234);
    expect(parseDecimalToMinor("1.5", "KWD")).toBe(1500);
    expect(parseDecimalToMinor("12.34", "eur")).toBe(1234);
  });

  it("accepts extra fraction digits only when they are zeros", () => {
    expect(parseDecimalToMinor("1.230", "EUR")).toBe(123);
    expect(parseDecimalToMinor("0.30000000000000000000", "EUR")).toBe(30);
    expect(() => parseDecimalToMinor("1.234", "EUR")).toThrow(MoneyParseError);
    expect(() => parseDecimalToMinor("1.2300001", "EUR")).toThrow(MoneyParseError);
    expect(() => parseDecimalToMinor("500.5", "JPY")).toThrow(MoneyParseError);
    expect(() => parseDecimalToMinor("1.2345", "BHD")).toThrow(MoneyParseError);
  });

  it("turns negative zero into zero", () => {
    expect(Object.is(parseDecimalToMinor("-0", "EUR"), 0)).toBe(true);
    expect(Object.is(parseDecimalToMinor("-0.00", "EUR"), 0)).toBe(true);
    expect(Object.is(parseDecimalToMinor("-0.000", "EUR"), 0)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "NaN",
    "Infinity",
    "1,234.50",
    "1.234,50",
    "12,5",
    "1 000.00",
    "1_000",
    "1e3",
    "1E3",
    "1.5e1",
    "0x10",
    ".5",
    "5.",
    "--1",
    "+-1",
    "1.2.3",
    "12abc",
    "１２",
  ])("rejects %j", (input) => {
    expect(() => parseDecimalToMinor(input, "EUR")).toThrow(MoneyParseError);
  });

  it("rejects amounts beyond the safe integer range", () => {
    expect(parseDecimalToMinor("90071992547409.91", "EUR")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseDecimalToMinor("-90071992547409.91", "EUR")).toBe(-Number.MAX_SAFE_INTEGER);
    expect(() => parseDecimalToMinor("90071992547409.92", "EUR")).toThrow(MoneyParseError);
    expect(() => parseDecimalToMinor("-90071992547409.92", "EUR")).toThrow(MoneyParseError);
    expect(() => parseDecimalToMinor(`1${"0".repeat(40)}`, "EUR")).toThrow(MoneyParseError);
    expect(() => parseDecimalToMinor("9007199254740992", "JPY")).toThrow(MoneyParseError);
  });

  it("throws a RangeError for an invalid currency", () => {
    expect(() => parseDecimalToMinor("1", "EURO")).toThrow(RangeError);
  });

  it("does not echo the rejected input in the error message", () => {
    expect(() => parseDecimalToMinor("secret-1,5", "EUR")).toThrow(/^Invalid decimal amount$/);
  });
});

describe("minorToDecimalString", () => {
  it("builds exact decimal strings", () => {
    expect(minorToDecimalString(-1234, "EUR")).toBe("-12.34");
    expect(minorToDecimalString(1234, "EUR")).toBe("12.34");
    expect(minorToDecimalString(5, "EUR")).toBe("0.05");
    expect(minorToDecimalString(-5, "EUR")).toBe("-0.05");
    expect(minorToDecimalString(0, "EUR")).toBe("0.00");
    expect(minorToDecimalString(-0, "EUR")).toBe("0.00");
    expect(minorToDecimalString(500, "JPY")).toBe("500");
    expect(minorToDecimalString(-7, "JPY")).toBe("-7");
    expect(minorToDecimalString(1234, "BHD")).toBe("1.234");
    expect(minorToDecimalString(7, "BHD")).toBe("0.007");
  });

  it("accepts bigint beyond the safe integer range", () => {
    expect(minorToDecimalString(12345678901234567890n, "EUR")).toBe("123456789012345678.90");
    expect(minorToDecimalString(-12345678901234567890n, "EUR")).toBe("-123456789012345678.90");
  });

  it("rejects numbers that are not safe integers", () => {
    expect(() => minorToDecimalString(1.5, "EUR")).toThrow(RangeError);
    expect(() => minorToDecimalString(Number.NaN, "EUR")).toThrow(RangeError);
    expect(() => minorToDecimalString(2 ** 53, "EUR")).toThrow(RangeError);
  });

  it("round-trips with parseDecimalToMinor", () => {
    for (const currency of ["EUR", "JPY", "BHD"]) {
      for (const minor of [0, 1, -1, 99, 100, -100, 123456, -987654321, Number.MAX_SAFE_INTEGER]) {
        expect(parseDecimalToMinor(minorToDecimalString(minor, currency), currency)).toBe(minor);
      }
    }
  });
});

describe("formatMoney", () => {
  it("formats it-IT with grouping from four digits and the Intl spacing", () => {
    expect(formatMoney(123450, "EUR", "it-IT")).toBe(`1.234,50${NBSP}€`);
    expect(formatMoney(99, "EUR", "it-IT")).toBe(`0,99${NBSP}€`);
    expect(formatMoney(-123450, "EUR", "it-IT")).toBe(`-1.234,50${NBSP}€`);
    expect(formatMoney(123450, "USD", "it-IT")).toBe(`1.234,50${NBSP}USD`);
  });

  it("formats en-GB", () => {
    expect(formatMoney(123450, "EUR", "en-GB")).toBe("€1,234.50");
    expect(formatMoney(-123450, "EUR", "en-GB")).toBe("-€1,234.50");
    expect(formatMoney(99, "EUR", "en-GB")).toBe("€0.99");
    expect(formatMoney(123450, "GBP", "en-GB")).toBe("£1,234.50");
  });

  it("accepts bigint input", () => {
    expect(formatMoney(123450n, "EUR", "en-GB")).toBe("€1,234.50");
    expect(formatMoney(-5n, "EUR", "en-GB")).toBe("-€0.05");
  });

  it("is exact beyond double precision", () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER, "EUR", "en-GB")).toBe("€90,071,992,547,409.91");
    expect(formatMoney(123456789012345678901n, "EUR", "en-GB")).toBe(
      "€1,234,567,890,123,456,789.01",
    );
  });

  it("follows the currency's minor digits (JPY none, BHD three)", () => {
    expect(formatMoney(1234, "JPY", "en-GB")).toBe("JP¥1,234");
    expect(formatMoney(1234, "JPY", "it-IT")).toBe(`1.234${NBSP}JPY`);
    expect(formatMoney(-500, "JPY", "en-GB")).toBe("-JP¥500");
    expect(formatMoney(1234, "BHD", "en-GB")).toBe(`BHD${NBSP}1.234`);
    expect(formatMoney(1234, "BHD", "it-IT")).toBe(`1,234${NBSP}BHD`);
    expect(formatMoney(-1234, "BHD", "en-GB")).toBe(`-BHD${NBSP}1.234`);
  });

  it("never shows a minus for zero, including -0", () => {
    expect(formatMoney(0, "EUR", "en-GB")).toBe("€0.00");
    expect(formatMoney(-0, "EUR", "en-GB")).toBe("€0.00");
    expect(formatMoney(-0, "EUR", "it-IT")).toBe(`0,00${NBSP}€`);
    expect(formatMoney(0, "EUR", "en-GB", { sign: "always" })).toBe("€0.00");
  });

  it("supports the sign modes", () => {
    expect(formatMoney(123450, "EUR", "en-GB", { sign: "always" })).toBe("+€1,234.50");
    expect(formatMoney(-123450, "EUR", "en-GB", { sign: "always" })).toBe("-€1,234.50");
    expect(formatMoney(123450, "EUR", "it-IT", { sign: "always" })).toBe(`+1.234,50${NBSP}€`);
    expect(formatMoney(-123450, "EUR", "en-GB", { sign: "never" })).toBe("€1,234.50");
    expect(formatMoney(-123450, "EUR", "it-IT", { sign: "never" })).toBe(`1.234,50${NBSP}€`);
    expect(formatMoney(-123450, "EUR", "en-GB", { sign: "auto" })).toBe("-€1,234.50");
  });

  it("masks without any digit", () => {
    expect(MASKED_AMOUNT).toBe("•••••");
    expect(formatMoney(123450, "EUR", "it-IT", { masked: true })).toBe(MASKED_AMOUNT);
    expect(formatMoney(-5, "JPY", "en-GB", { masked: true, sign: "always" })).toBe(MASKED_AMOUNT);
  });

  it("rejects a number that is not a safe integer and an invalid currency", () => {
    expect(() => formatMoney(12.5, "EUR", "en-GB")).toThrow(RangeError);
    expect(() => formatMoney(100, "EURO", "en-GB")).toThrow(RangeError);
  });
});

describe("sumMinor", () => {
  it("adds integers exactly", () => {
    expect(sumMinor([])).toBe(0);
    expect(sumMinor([1000, -250, 5])).toBe(755);
    expect(sumMinor([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])).toBe(0);
  });

  it("tolerates an unsafe intermediate total when the result is safe", () => {
    expect(sumMinor([Number.MAX_SAFE_INTEGER, 10, -10])).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("throws when the result or an input is not a safe integer", () => {
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
    expect(() => sumMinor([-Number.MAX_SAFE_INTEGER, -1])).toThrow(RangeError);
    expect(() => sumMinor([1, 0.5])).toThrow(RangeError);
    expect(() => sumMinor([Number.NaN])).toThrow(RangeError);
  });
});
