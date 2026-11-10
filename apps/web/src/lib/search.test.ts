import { describe, expect, it } from "vitest";
import { matchesQuery, naturalCollator, normalizeForSearch } from "./search";

describe("matchesQuery", () => {
  it("ignores case and accents in both the query and the haystack", () => {
    expect(matchesQuery("Caffè Roma", "CAFFE")).toBe(true);
    expect(matchesQuery("Caffe Roma", "caffè")).toBe(true);
    expect(matchesQuery("Società Elettrica", "societa elettrica")).toBe(true);
  });

  it("needs every word of the query, in any order", () => {
    expect(matchesQuery("Coffee shop Milano", "milano coffee")).toBe(true);
    expect(matchesQuery("Coffee shop Milano", "milano rent")).toBe(false);
  });

  it("searches across the parts of a row", () => {
    expect(matchesQuery(["Landlord", "Rent November", "-850,00"], "rent landlord")).toBe(true);
    expect(matchesQuery(["Landlord", "Rent November", "-850,00"], "850")).toBe(true);
    expect(matchesQuery(["Landlord", "Rent November"], "gas")).toBe(false);
  });

  it("matches everything for an empty or blank query", () => {
    expect(matchesQuery("anything", "")).toBe(true);
    expect(matchesQuery([], "   ")).toBe(true);
  });

  it("re-exports the shared normaliser", () => {
    expect(normalizeForSearch("  Caffè   ÀB ")).toBe("caffe ab");
  });
});

describe("naturalCollator", () => {
  it("sorts numbers inside text by value and ignores case and accents", () => {
    const names = ["Conto 10", "conto 2", "Conto 1", "Cònto 3"];
    expect([...names].sort(naturalCollator("it-IT").compare)).toEqual([
      "Conto 1",
      "conto 2",
      "Cònto 3",
      "Conto 10",
    ]);
    expect(naturalCollator("en-GB").compare("é", "e")).toBe(0);
  });
});
