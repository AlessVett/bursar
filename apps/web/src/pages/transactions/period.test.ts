import { formatLocalDate, toLocalDate } from "@bursar/shared";
import { describe, expect, it } from "vitest";
import { periodFromRange, readPeriod, relativeDayLabel, resolvePeriod } from "./period";

const TODAY = "2026-11-09";

describe("resolvePeriod", () => {
  it("resolves the presets to local date ranges ending today", () => {
    expect(resolvePeriod({ period: "30d" }, TODAY)).toEqual({ from: "2026-10-11", to: TODAY });
    expect(resolvePeriod({ period: "90d" }, TODAY)).toEqual({ from: "2026-08-12", to: TODAY });
    expect(resolvePeriod({ period: "12m" }, TODAY)).toEqual({ from: "2025-11-10", to: TODAY });
    expect(resolvePeriod({ period: "all" }, TODAY)).toEqual({ from: null, to: null });
  });

  it("clamps 29 February when going back twelve months", () => {
    expect(resolvePeriod({ period: "12m" }, "2028-02-29")).toEqual({
      from: "2027-03-01",
      to: "2028-02-29",
    });
    expect(resolvePeriod({ period: "12m" }, "2025-03-01")).toEqual({
      from: "2024-03-02",
      to: "2025-03-01",
    });
  });

  it("counts calendar days across daylight saving changes", () => {
    // Europe/Rome moves to summer time on 29 March 2026 and back on 25 October 2026.
    expect(resolvePeriod({ period: "30d" }, "2026-03-29")).toEqual({
      from: "2026-02-28",
      to: "2026-03-29",
    });
    expect(resolvePeriod({ period: "30d" }, "2026-10-25")).toEqual({
      from: "2026-09-26",
      to: "2026-10-25",
    });
    // 23:30 UTC on 28 March is already 29 March in Rome: "today" follows the owner's zone.
    const today = toLocalDate(Date.UTC(2026, 2, 28, 23, 30), "Europe/Rome");
    expect(today).toBe("2026-03-29");
    expect(resolvePeriod({ period: "90d" }, today)).toEqual({ from: "2025-12-30", to: today });
  });

  it("keeps custom ranges, swaps reversed ones and allows an open side", () => {
    expect(
      resolvePeriod({ period: "custom", from: "2026-11-01", to: "2026-11-03" }, TODAY),
    ).toEqual({ from: "2026-11-01", to: "2026-11-03" });
    expect(
      resolvePeriod({ period: "custom", from: "2026-11-03", to: "2026-11-01" }, TODAY),
    ).toEqual({ from: "2026-11-01", to: "2026-11-03" });
    expect(resolvePeriod({ period: "custom", from: "2026-11-01" }, TODAY)).toEqual({
      from: "2026-11-01",
      to: null,
    });
    expect(resolvePeriod({ period: "custom", to: "2026-11-01" }, TODAY)).toEqual({
      from: null,
      to: "2026-11-01",
    });
  });

  it("falls back to the last 30 days when a custom range has no valid date", () => {
    expect(resolvePeriod({ period: "custom" }, TODAY)).toEqual({ from: "2026-10-11", to: TODAY });
    expect(resolvePeriod({ period: "custom", from: "2026-02-30", to: "yesterday" }, TODAY)).toEqual(
      { from: "2026-10-11", to: TODAY },
    );
  });
});

describe("periodFromRange", () => {
  it("recognises the presets, the open range and anything else as custom", () => {
    expect(periodFromRange(null, null, TODAY)).toBe("all");
    expect(periodFromRange("2026-10-11", TODAY, TODAY)).toBe("30d");
    expect(periodFromRange("2026-08-12", TODAY, TODAY)).toBe("90d");
    expect(periodFromRange("2025-11-10", TODAY, TODAY)).toBe("12m");
    expect(periodFromRange("2026-10-11", "2026-11-08", TODAY)).toBe("custom");
    expect(periodFromRange("2026-11-01", null, TODAY)).toBe("custom");
    expect(periodFromRange(null, TODAY, TODAY)).toBe("custom");
  });
});

describe("readPeriod", () => {
  it("treats a link with only from and to as a custom period", () => {
    expect(readPeriod({ period: "30d", from: "2026-11-01", to: "2026-11-03" }, TODAY)).toEqual({
      preset: "custom",
      from: "2026-11-01",
      to: "2026-11-03",
    });
    expect(readPeriod({ period: "30d", from: "2026-08-12", to: TODAY }, TODAY)).toEqual({
      preset: "90d",
      from: "2026-08-12",
      to: TODAY,
    });
  });

  it("falls back to the default and ignores dates next to a preset", () => {
    expect(readPeriod({ period: "custom", from: "", to: "" }, TODAY)).toEqual({
      preset: "30d",
      from: "2026-10-11",
      to: TODAY,
    });
    expect(readPeriod({ period: "7d", from: "", to: "" }, TODAY)).toEqual({
      preset: "30d",
      from: "2026-10-11",
      to: TODAY,
    });
    expect(readPeriod({ period: "90d", from: "2026-11-01", to: "" }, TODAY)).toEqual({
      preset: "90d",
      from: "2026-08-12",
      to: TODAY,
    });
    expect(readPeriod({ period: "all", from: "", to: "" }, TODAY)).toEqual({
      preset: "all",
      from: null,
      to: null,
    });
  });
});

describe("relativeDayLabel", () => {
  it("names nearby days and prints older ones as dates", () => {
    expect(relativeDayLabel(TODAY, TODAY, "en-GB")).toBe("Today");
    expect(relativeDayLabel("2026-11-08", TODAY, "en-GB")).toBe("Yesterday");
    expect(relativeDayLabel("2026-11-06", TODAY, "en-GB")).toBe("3 days ago");
    expect(relativeDayLabel("2026-11-11", TODAY, "en-GB")).toBe("In 2 days");
    expect(relativeDayLabel("2026-11-08", TODAY, "it-IT")).toBe("Ieri");
    expect(relativeDayLabel("2026-09-25", TODAY, "en-GB")).toBe(
      formatLocalDate("2026-09-25", "en-GB", { style: "medium" }),
    );
    expect(relativeDayLabel("2026-09-26", TODAY, "en-GB")).toBe("44 days ago");
  });
});
