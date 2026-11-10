import { describe, expect, it } from "vitest";
import {
  addDays,
  calendarDaysUntil,
  diffDays,
  formatAbsolute,
  formatLocalDate,
  formatRelative,
  formatRelativeDay,
  localDateSchema,
  localTimeOfDay,
  RELATIVE_LIMIT_DAYS,
  startOfLocalDay,
  toLocalDate,
} from "./dates";

const ROME = "Europe/Rome";
const NEW_YORK = "America/New_York";
const HOUR = 3_600_000;
const iso = (value: string) => Date.parse(value);

describe("localDateSchema", () => {
  it("accepts real calendar dates", () => {
    for (const date of ["2026-11-09", "2024-02-29", "2000-02-29", "2026-12-31", "0999-01-01"]) {
      expect(localDateSchema.safeParse(date).success).toBe(true);
    }
  });

  it("rejects malformed strings and dates that do not exist", () => {
    for (const date of [
      "2026-02-29",
      "1900-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-04-31",
      "2026-11-00",
      "2026-1-9",
      "26-11-09",
      "2026/11/09",
      "2026-11-09T00:00:00Z",
      " 2026-11-09",
      "",
    ]) {
      expect(localDateSchema.safeParse(date).success, date).toBe(false);
    }
  });
});

describe("toLocalDate", () => {
  it("resolves the calendar date in the given time zone", () => {
    const instant = iso("2026-11-09T23:30:00Z");
    expect(toLocalDate(instant, "UTC")).toBe("2026-11-09");
    expect(toLocalDate(instant, ROME)).toBe("2026-11-10");
    expect(toLocalDate(instant, NEW_YORK)).toBe("2026-11-09");
    expect(toLocalDate(new Date(instant), ROME)).toBe("2026-11-10");
  });

  it("switches exactly at local midnight", () => {
    // Rome is UTC+1 in November: local midnight is 23:00 UTC.
    expect(toLocalDate(iso("2026-11-09T22:59:59.999Z"), ROME)).toBe("2026-11-09");
    expect(toLocalDate(iso("2026-11-09T23:00:00.000Z"), ROME)).toBe("2026-11-10");
    // New York is UTC-5 in November: local midnight is 05:00 UTC.
    expect(toLocalDate(iso("2026-11-10T04:59:59.999Z"), NEW_YORK)).toBe("2026-11-09");
    expect(toLocalDate(iso("2026-11-10T05:00:00.000Z"), NEW_YORK)).toBe("2026-11-10");
  });

  it("rejects an invalid instant", () => {
    expect(() => toLocalDate(Number.NaN, ROME)).toThrow(RangeError);
    expect(() => toLocalDate(new Date("nope"), ROME)).toThrow(RangeError);
  });
});

describe("addDays and diffDays", () => {
  it("crosses month, year and leap-day boundaries", () => {
    expect(addDays("2026-11-09", 1)).toBe("2026-11-10");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-11-09", 0)).toBe("2026-11-09");
    expect(addDays("2026-11-09", 365)).toBe("2027-11-09");
    expect(addDays("2026-11-09", -45)).toBe("2026-09-25");
  });

  it("counts whole days in either direction", () => {
    expect(diffDays("2026-11-10", "2026-11-09")).toBe(1);
    expect(diffDays("2026-11-09", "2026-11-10")).toBe(-1);
    expect(diffDays("2026-11-09", "2026-11-09")).toBe(0);
    expect(diffDays("2027-01-01", "2026-01-01")).toBe(365);
    expect(diffDays("2025-03-01", "2024-03-01")).toBe(365);
    expect(diffDays("2024-03-01", "2023-03-01")).toBe(366);
  });

  it("agrees with itself for every day of a leap year", () => {
    let date = "2024-01-01";
    for (let index = 0; index < 366; index += 1) {
      expect(diffDays(date, "2024-01-01")).toBe(index);
      expect(addDays("2024-01-01", index)).toBe(date);
      date = addDays(date, 1);
    }
    expect(date).toBe("2025-01-01");
  });

  it("rejects invalid dates and fractional day counts", () => {
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError);
    expect(() => addDays("nope", 1)).toThrow(RangeError);
    expect(() => addDays("2026-11-09", 1.5)).toThrow(RangeError);
    expect(() => diffDays("2026-13-01", "2026-01-01")).toThrow(RangeError);
  });
});

describe("startOfLocalDay", () => {
  it("returns the first instant of the local day", () => {
    expect(startOfLocalDay("2026-11-09", "UTC")).toBe(iso("2026-11-09T00:00:00Z"));
    expect(startOfLocalDay("2026-11-09", ROME)).toBe(iso("2026-11-08T23:00:00Z"));
    expect(startOfLocalDay("2026-07-09", ROME)).toBe(iso("2026-07-08T22:00:00Z"));
    expect(startOfLocalDay("2026-11-09", NEW_YORK)).toBe(iso("2026-11-09T05:00:00Z"));
  });

  it("handles the 23-hour and 25-hour days in Europe/Rome", () => {
    const springStart = startOfLocalDay("2026-03-29", ROME);
    const springEnd = startOfLocalDay("2026-03-30", ROME);
    expect(springStart).toBe(iso("2026-03-28T23:00:00Z"));
    expect(springEnd).toBe(iso("2026-03-29T22:00:00Z"));
    expect((springEnd - springStart) / HOUR).toBe(23);

    const autumnStart = startOfLocalDay("2026-10-25", ROME);
    const autumnEnd = startOfLocalDay("2026-10-26", ROME);
    expect(autumnStart).toBe(iso("2026-10-24T22:00:00Z"));
    expect(autumnEnd).toBe(iso("2026-10-25T23:00:00Z"));
    expect((autumnEnd - autumnStart) / HOUR).toBe(25);
  });

  it("handles the 23-hour and 25-hour days in America/New_York", () => {
    const springStart = startOfLocalDay("2026-03-08", NEW_YORK);
    const springEnd = startOfLocalDay("2026-03-09", NEW_YORK);
    expect(springStart).toBe(iso("2026-03-08T05:00:00Z"));
    expect(springEnd).toBe(iso("2026-03-09T04:00:00Z"));
    expect((springEnd - springStart) / HOUR).toBe(23);

    const autumnStart = startOfLocalDay("2026-11-01", NEW_YORK);
    const autumnEnd = startOfLocalDay("2026-11-02", NEW_YORK);
    expect(autumnStart).toBe(iso("2026-11-01T04:00:00Z"));
    expect(autumnEnd).toBe(iso("2026-11-02T05:00:00Z"));
    expect((autumnEnd - autumnStart) / HOUR).toBe(25);
  });

  it.each([
    [ROME, 2026],
    [ROME, 2024],
    [NEW_YORK, 2026],
    [NEW_YORK, 2024],
  ])("round-trips with toLocalDate for every day of %s %d", (timeZone, year) => {
    let date = `${year}-01-01`;
    while (date < `${year + 1}-01-01`) {
      const start = startOfLocalDay(date, timeZone);
      expect(toLocalDate(start, timeZone), date).toBe(date);
      expect(toLocalDate(start - 1, timeZone), date).toBe(addDays(date, -1));
      date = addDays(date, 1);
    }
  });

  it("rejects an invalid date", () => {
    expect(() => startOfLocalDay("2026-02-30", ROME)).toThrow(RangeError);
  });
});

describe("localTimeOfDay", () => {
  it("formats HH:MM in the time zone", () => {
    expect(localTimeOfDay(iso("2026-11-09T13:05:00Z"), ROME)).toBe("14:05");
    expect(localTimeOfDay(iso("2026-11-09T13:05:00Z"), NEW_YORK)).toBe("08:05");
    expect(localTimeOfDay(new Date("2026-07-09T13:05:00Z"), ROME)).toBe("15:05");
  });

  it("shows midnight as 00:00, never 24:00", () => {
    expect(localTimeOfDay(iso("2026-11-09T23:00:00Z"), ROME)).toBe("00:00");
    expect(localTimeOfDay(iso("2026-11-09T23:30:00Z"), ROME)).toBe("00:30");
    expect(localTimeOfDay(iso("2026-11-10T05:00:00Z"), NEW_YORK)).toBe("00:00");
  });

  it("skips the hour that does not exist on a spring-forward day", () => {
    expect(localTimeOfDay(iso("2026-03-29T00:59:00Z"), ROME)).toBe("01:59");
    expect(localTimeOfDay(iso("2026-03-29T01:00:00Z"), ROME)).toBe("03:00");
  });
});

describe("calendarDaysUntil", () => {
  const now = iso("2026-11-09T10:00:00Z"); // 11:00 in Rome

  it("is 0 for later today and for earlier today", () => {
    expect(calendarDaysUntil(iso("2026-11-09T21:00:00Z"), now, ROME)).toBe(0);
    expect(calendarDaysUntil(iso("2026-11-08T23:30:00Z"), now, ROME)).toBe(0);
  });

  it("counts calendar days, not 24-hour blocks", () => {
    // 23:50 in Rome now, tomorrow at 00:30 is 40 minutes away and already day 1.
    expect(calendarDaysUntil(iso("2026-11-09T23:30:00Z"), iso("2026-11-09T22:50:00Z"), ROME)).toBe(
      1,
    );
    // The same target seen from New York is still today.
    expect(
      calendarDaysUntil(iso("2026-11-09T23:30:00Z"), iso("2026-11-09T22:50:00Z"), NEW_YORK),
    ).toBe(0);
    expect(calendarDaysUntil(iso("2026-11-10T22:59:00Z"), now, ROME)).toBe(1);
    expect(calendarDaysUntil(iso("2026-11-10T23:00:00Z"), now, ROME)).toBe(2);
  });

  it("is negative in the past", () => {
    expect(calendarDaysUntil(iso("2026-11-08T22:30:00Z"), now, ROME)).toBe(-1);
    expect(calendarDaysUntil(iso("2026-10-10T10:00:00Z"), now, ROME)).toBe(-30);
  });

  it("accepts Date objects", () => {
    expect(calendarDaysUntil(new Date("2026-11-12T10:00:00Z"), new Date(now), ROME)).toBe(3);
  });

  it("stays correct across a spring-forward change (23-hour day)", () => {
    // Saturday 21:00 in Rome (20:00 UTC) to Monday 00:30 CEST (22:30 UTC on Sunday): 2 calendar days, 25.5 hours.
    expect(calendarDaysUntil(iso("2026-03-29T22:30:00Z"), iso("2026-03-28T20:00:00Z"), ROME)).toBe(
      2,
    );
    // Sunday 23:30 CEST to Monday 00:10 CEST is 1 day.
    expect(calendarDaysUntil(iso("2026-03-29T22:10:00Z"), iso("2026-03-29T21:30:00Z"), ROME)).toBe(
      1,
    );
  });

  it("stays correct across a fall-back change (25-hour day)", () => {
    // Sunday 25 October 2026 has 25 hours: 00:30 CEST and 23:30 CET are the same calendar day.
    expect(calendarDaysUntil(iso("2026-10-25T22:30:00Z"), iso("2026-10-24T22:30:00Z"), ROME)).toBe(
      0,
    );
    expect(calendarDaysUntil(iso("2026-10-25T23:30:00Z"), iso("2026-10-24T22:30:00Z"), ROME)).toBe(
      1,
    );
  });

  it("stays correct across New York DST changes", () => {
    expect(
      calendarDaysUntil(iso("2026-03-09T04:30:00Z"), iso("2026-03-08T05:30:00Z"), NEW_YORK),
    ).toBe(1);
    expect(
      calendarDaysUntil(iso("2026-11-02T04:59:00Z"), iso("2026-11-01T03:59:00Z"), NEW_YORK),
    ).toBe(1);
  });
});

describe("formatAbsolute and formatLocalDate", () => {
  const instant = iso("2026-11-09T13:30:00Z");

  it("formats the date in the time zone and locale", () => {
    expect(formatAbsolute(instant, "en-GB", ROME)).toBe("9 Nov 2026");
    expect(formatAbsolute(instant, "it-IT", ROME)).toBe("9 nov 2026");
    expect(formatAbsolute(iso("2026-11-09T23:30:00Z"), "en-GB", ROME)).toBe("10 Nov 2026");
    expect(formatAbsolute(iso("2026-11-09T23:30:00Z"), "en-GB", NEW_YORK)).toBe("9 Nov 2026");
  });

  it("adds the time on request", () => {
    expect(formatAbsolute(instant, "en-GB", ROME, { withTime: true })).toBe("9 Nov 2026, 14:30");
    expect(formatAbsolute(instant, "it-IT", ROME, { withTime: true })).toBe("9 nov 2026, 14:30");
    expect(formatAbsolute(instant, "en-GB", NEW_YORK, { withTime: true })).toBe(
      "9 Nov 2026, 08:30",
    );
    expect(formatAbsolute(instant, "en-GB", ROME, { withTime: false })).toBe("9 Nov 2026");
  });

  it("formats a LocalDate without any time zone shift", () => {
    expect(formatLocalDate("2026-11-09", "en-GB")).toBe("9 Nov 2026");
    expect(formatLocalDate("2026-11-09", "it-IT")).toBe("9 nov 2026");
    expect(formatLocalDate("2026-11-09", "en-GB", { style: "short" })).toBe("09/11/2026");
    expect(formatLocalDate("2026-11-09", "it-IT", { style: "short" })).toBe("09/11/2026");
    expect(formatLocalDate("2026-11-09", "en-GB", { style: "long" })).toBe("9 November 2026");
    expect(formatLocalDate("2026-11-09", "it-IT", { style: "long" })).toBe("9 novembre 2026");
  });

  it("adds the weekday on request", () => {
    expect(formatLocalDate("2026-11-09", "en-GB", { weekday: true })).toBe("Mon, 9 Nov 2026");
    expect(formatLocalDate("2026-11-09", "it-IT", { weekday: true })).toBe("lun 9 nov 2026");
    expect(formatLocalDate("2026-11-09", "en-GB", { style: "long", weekday: true })).toBe(
      "Monday, 9 November 2026",
    );
    expect(formatLocalDate("2026-11-09", "it-IT", { style: "long", weekday: true })).toBe(
      "lunedì 9 novembre 2026",
    );
  });

  it("rejects an invalid LocalDate", () => {
    expect(() => formatLocalDate("2026-02-30", "en-GB")).toThrow(RangeError);
  });
});

describe("formatRelative", () => {
  const now = iso("2026-11-09T12:00:00Z"); // 13:00 in Rome
  const relative = (instant: number, locale: string, timeZone = ROME, at = now) =>
    formatRelative(instant, at, locale, timeZone);

  it("says now for less than a minute, in both directions", () => {
    expect(relative(now, "en-GB")).toBe("now");
    expect(relative(now - 59_000, "en-GB")).toBe("now");
    expect(relative(now + 59_000, "en-GB")).toBe("now");
    expect(relative(now - 30_000, "it-IT")).toBe("ora");
  });

  it("uses minutes below an hour", () => {
    expect(relative(now - 5 * 60_000, "en-GB")).toBe("5 minutes ago");
    expect(relative(now - 5 * 60_000, "it-IT")).toBe("5 minuti fa");
    expect(relative(now - 60_000, "en-GB")).toBe("1 minute ago");
    expect(relative(now - 59 * 60_000 - 59_000, "en-GB")).toBe("59 minutes ago");
    expect(relative(now + 10 * 60_000, "en-GB")).toBe("in 10 minutes");
    expect(relative(now + 10 * 60_000, "it-IT")).toBe("tra 10 minuti");
  });

  it("uses hours below a day, also across midnight", () => {
    expect(relative(now - HOUR, "en-GB")).toBe("1 hour ago");
    expect(relative(now - 3 * HOUR, "en-GB")).toBe("3 hours ago");
    expect(relative(now - 3 * HOUR, "it-IT")).toBe("3 ore fa");
    expect(relative(now + 2 * HOUR, "en-GB")).toBe("in 2 hours");
    expect(relative(now + 2 * HOUR, "it-IT")).toBe("tra 2 ore");
    expect(relative(now - 23 * HOUR - 59 * 60_000, "en-GB")).toBe("23 hours ago");
    // 00:20 in Rome, an instant at 23:50 the evening before is 30 minutes ago, not "yesterday".
    const justAfterMidnight = iso("2026-11-09T23:20:00Z");
    expect(relative(iso("2026-11-09T22:50:00Z"), "en-GB", ROME, justAfterMidnight)).toBe(
      "30 minutes ago",
    );
  });

  it("uses calendar days in the time zone from 24 hours on", () => {
    expect(relative(now - 24 * HOUR, "en-GB")).toBe("yesterday");
    expect(relative(now - 24 * HOUR, "it-IT")).toBe("ieri");
    expect(relative(now + 24 * HOUR, "en-GB")).toBe("tomorrow");
    expect(relative(now + 24 * HOUR, "it-IT")).toBe("domani");
    expect(relative(now + 3 * 24 * HOUR, "en-GB")).toBe("in 3 days");
    expect(relative(now + 3 * 24 * HOUR, "it-IT")).toBe("tra 3 giorni");
    expect(relative(now - 10 * 24 * HOUR, "en-GB")).toBe("10 days ago");
    expect(relative(now - 10 * 24 * HOUR, "it-IT")).toBe("10 giorni fa");
  });

  it("counts calendar days near local midnight", () => {
    // 00:30 in Rome on 10 November. An instant at 23:45 on 8 November is 24 h 45 min ago
    // and two calendar days back; in New York both fall on the same evening, one day apart.
    const late = iso("2026-11-09T23:30:00Z");
    const evening = iso("2026-11-08T22:45:00Z");
    expect(relative(evening, "en-GB", ROME, late)).toBe("2 days ago");
    expect(relative(evening, "en-GB", NEW_YORK, late)).toBe("yesterday");
    // 24 h 45 min ahead of 23:15 on the 9th (Rome) lands on the 11th, two days ahead.
    const early = iso("2026-11-09T22:15:00Z");
    expect(relative(iso("2026-11-10T23:00:00Z"), "en-GB", ROME, early)).toBe("in 2 days");
    expect(relative(iso("2026-11-10T23:00:00Z"), "en-GB", NEW_YORK, early)).toBe("tomorrow");
  });

  it("counts calendar days across the Rome DST changes", () => {
    // Exactly 24 hours apart, but 00:30 CEST on the 30th is two calendar days after 23:30 CET on the 28th.
    expect(
      formatRelative(iso("2026-03-28T22:30:00Z"), iso("2026-03-29T22:30:00Z"), "en-GB", ROME),
    ).toBe("2 days ago");
    // Autumn: the 25-hour day keeps the same calendar day for 24 hours.
    expect(
      formatRelative(iso("2026-10-24T22:30:00Z"), iso("2026-10-25T22:30:00Z"), "en-GB", ROME),
    ).toBe("today");
    expect(
      formatRelative(iso("2026-10-24T22:30:00Z"), iso("2026-10-25T23:30:00Z"), "en-GB", ROME),
    ).toBe("yesterday");
  });

  it("switches to the absolute date at 45 calendar days, in both directions", () => {
    expect(RELATIVE_LIMIT_DAYS).toBe(45);
    expect(relative(iso("2026-09-26T12:00:00Z"), "en-GB")).toBe("44 days ago");
    expect(relative(iso("2026-09-25T12:00:00Z"), "en-GB")).toBe("25 Sept 2026");
    expect(relative(iso("2026-09-25T12:00:00Z"), "it-IT")).toBe("25 set 2026");
    expect(relative(iso("2026-09-01T12:00:00Z"), "en-GB")).toBe("1 Sept 2026");
    expect(relative(iso("2026-12-23T12:00:00Z"), "en-GB")).toBe("in 44 days");
    expect(relative(iso("2026-12-24T12:00:00Z"), "en-GB")).toBe("24 Dec 2026");
    expect(relative(iso("2026-12-24T12:00:00Z"), "it-IT")).toBe("24 dic 2026");
    expect(relative(iso("2026-12-24T12:00:00Z"), "en-GB")).toBe(
      formatAbsolute(iso("2026-12-24T12:00:00Z"), "en-GB", ROME),
    );
  });

  it("accepts Date objects and rejects invalid ones", () => {
    expect(formatRelative(new Date(now - HOUR), new Date(now), "en-GB", ROME)).toBe("1 hour ago");
    expect(() => formatRelative(Number.NaN, now, "en-GB", ROME)).toThrow(RangeError);
  });
});

describe("formatRelativeDay", () => {
  it("names nearby calendar days in sentence case and prints older ones as dates", () => {
    const today = "2026-11-09";
    expect(formatRelativeDay(today, today, "en-GB")).toBe("Today");
    expect(formatRelativeDay("2026-11-08", today, "en-GB")).toBe("Yesterday");
    expect(formatRelativeDay("2026-11-06", today, "en-GB")).toBe("3 days ago");
    expect(formatRelativeDay("2026-11-11", today, "en-GB")).toBe("In 2 days");
    expect(formatRelativeDay("2026-11-08", today, "it-IT")).toBe("Ieri");
    expect(formatRelativeDay("2026-09-26", today, "en-GB")).toBe("44 days ago");
    expect(formatRelativeDay("2026-09-25", today, "en-GB")).toBe(
      formatLocalDate("2026-09-25", "en-GB", { style: "medium" }),
    );
    expect(() => formatRelativeDay("2026-02-30", today, "en-GB")).toThrow(RangeError);
  });
});
