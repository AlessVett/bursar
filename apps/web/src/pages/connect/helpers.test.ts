import { describe, expect, it } from "vitest";
import { consentEndDate, consentOptions, defaultConsentDays } from "./consent";
import { CURATED_COUNTRIES, countryName, countryOptions } from "./countries";

describe("consent helpers", () => {
  it("defaults to the smaller of the bank maximum and the configured duration", () => {
    expect(defaultConsentDays(90, 180)).toBe(90);
    expect(defaultConsentDays(180, 60)).toBe(60);
    expect(defaultConsentDays(400, 500)).toBe(365);
    expect(defaultConsentDays(0, 90)).toBe(1);
  });

  it("offers presets up to the bank maximum plus the default and the maximum", () => {
    expect(consentOptions(90, 90)).toEqual([30, 60, 90]);
    expect(consentOptions(180, 45)).toEqual([30, 45, 60, 90, 180]);
    expect(consentOptions(20, 20)).toEqual([20]);
    expect(consentOptions(400, 365)).toEqual([30, 60, 90, 180, 365]);
  });

  it("computes the end date in the given time zone, ten minutes before the whole days", () => {
    const morning = Date.UTC(2026, 10, 9, 10, 0);
    expect(consentEndDate(morning, 90, "Europe/Rome")).toBe("2027-02-07");
    const lateEvening = Date.UTC(2026, 10, 9, 23, 55);
    expect(consentEndDate(lateEvening, 1, "UTC")).toBe("2026-11-10");
    expect(consentEndDate(lateEvening, 1, "Europe/Rome")).toBe("2026-11-11");
  });
});

describe("country helpers", () => {
  it("names a country in the given locale and falls back to the code", () => {
    expect(countryName("IT", "en-GB")).toBe("Italy");
    expect(countryName("IT", "it-IT")).toBe("Italia");
    expect(countryName("toolong", "en-GB")).toBe("toolong");
  });

  it("builds sorted, de-duplicated options by localised name", () => {
    const options = countryOptions(["IT", "DE", "FI", "it"], "en-GB");
    expect(options).toEqual([
      { value: "FI", label: "Finland" },
      { value: "DE", label: "Germany" },
      { value: "IT", label: "Italy" },
    ]);
  });

  it("keeps a curated list of two-letter codes without duplicates", () => {
    expect(CURATED_COUNTRIES.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
    expect(new Set(CURATED_COUNTRIES).size).toBe(CURATED_COUNTRIES.length);
    expect(CURATED_COUNTRIES).toContain("IT");
  });
});
