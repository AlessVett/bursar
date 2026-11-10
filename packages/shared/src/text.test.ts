import { describe, expect, it } from "vitest";
import { normalizeForSearch } from "./text";

describe("normalizeForSearch", () => {
  it("lowercases, strips accents and collapses whitespace", () => {
    expect(normalizeForSearch("  Caffè   ÀB ")).toBe("caffe ab");
  });

  it("handles precomposed and decomposed input alike", () => {
    expect(normalizeForSearch("café")).toBe("cafe");
    expect(normalizeForSearch("café")).toBe("cafe");
  });

  it("treats tabs, newlines and no-break spaces as spaces", () => {
    expect(normalizeForSearch("Pizza\t\tMargherita\n2 x")).toBe("pizza margherita 2 x");
  });

  it("does not leave a combining mark behind a dotted capital I", () => {
    expect(normalizeForSearch("İSTANBUL")).toBe("istanbul");
  });

  it("keeps digits, punctuation and currency symbols", () => {
    expect(normalizeForSearch("Bonifico -12,50 € Rif. A/1")).toBe("bonifico -12,50 € rif. a/1");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeForSearch("")).toBe("");
    expect(normalizeForSearch(" \t\n ")).toBe("");
  });

  it("is idempotent", () => {
    const once = normalizeForSearch("  Crème   BRÛLÉE ");
    expect(normalizeForSearch(once)).toBe(once);
  });
});
