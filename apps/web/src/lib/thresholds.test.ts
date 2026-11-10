import { describe, expect, it } from "vitest";
import {
  CONSENT_THRESHOLDS,
  consentUrgency,
  FRESHNESS_THRESHOLDS,
  freshnessUrgency,
  urgencyClasses,
} from "./thresholds";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = "Europe/Rome";
// 2026-11-09 11:00 in Rome (CET, UTC+1). The clocks changed on 2026-10-25, so the next
// weeks have no DST shift.
const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);

describe("thresholds", () => {
  it("expose the central values", () => {
    expect(CONSENT_THRESHOLDS).toEqual({ dangerDays: 3, warningDays: 14 });
    expect(FRESHNESS_THRESHOLDS).toEqual({ dangerHours: 72, warningHours: 24 });
  });
});

describe("consentUrgency", () => {
  it("is danger and expired when the consent is over", () => {
    expect(consentUrgency(NOW - HOUR, NOW, ZONE)).toEqual({
      urgency: "danger",
      daysLeft: 0,
      expired: true,
    });
    expect(consentUrgency(NOW, NOW, ZONE).expired).toBe(true);
    expect(consentUrgency(NOW - 2 * DAY, NOW, ZONE)).toEqual({
      urgency: "danger",
      daysLeft: -2,
      expired: true,
    });
  });

  it("is danger when it ends later today or within 3 calendar days", () => {
    expect(consentUrgency(NOW + 2 * HOUR, NOW, ZONE)).toEqual({
      urgency: "danger",
      daysLeft: 0,
      expired: false,
    });
    expect(consentUrgency(NOW + 3 * DAY, NOW, ZONE)).toMatchObject({
      urgency: "danger",
      daysLeft: 3,
    });
  });

  it("is warning from 4 to 14 calendar days", () => {
    expect(consentUrgency(NOW + 4 * DAY, NOW, ZONE)).toMatchObject({
      urgency: "warning",
      daysLeft: 4,
    });
    expect(consentUrgency(NOW + 14 * DAY, NOW, ZONE)).toMatchObject({
      urgency: "warning",
      daysLeft: 14,
    });
  });

  it("is ok beyond 14 days", () => {
    expect(consentUrgency(NOW + 15 * DAY, NOW, ZONE)).toEqual({
      urgency: "ok",
      daysLeft: 15,
      expired: false,
    });
  });

  it("counts local calendar days, not blocks of 24 hours", () => {
    // 2026-11-12 23:30 Rome is 3 days away; 2026-11-13 00:30 Rome is 4 days away, although
    // the two instants are only an hour apart.
    const before = Date.UTC(2026, 10, 12, 22, 30, 0);
    const after = Date.UTC(2026, 10, 12, 23, 30, 0);
    expect(consentUrgency(before, NOW, ZONE)).toMatchObject({ urgency: "danger", daysLeft: 3 });
    expect(consentUrgency(after, NOW, ZONE)).toMatchObject({ urgency: "warning", daysLeft: 4 });
  });
});

describe("freshnessUrgency", () => {
  it("is danger with no successful sync", () => {
    expect(freshnessUrgency(null, NOW)).toEqual({ urgency: "danger", hours: null });
  });

  it("is ok up to and including 24 hours", () => {
    expect(freshnessUrgency(NOW - 3 * HOUR, NOW)).toEqual({ urgency: "ok", hours: 3 });
    expect(freshnessUrgency(NOW - 24 * HOUR, NOW).urgency).toBe("ok");
  });

  it("is warning above 24 hours up to and including 72 hours", () => {
    expect(freshnessUrgency(NOW - 24 * HOUR - 1, NOW).urgency).toBe("warning");
    expect(freshnessUrgency(NOW - 72 * HOUR, NOW).urgency).toBe("warning");
  });

  it("is danger above 72 hours", () => {
    expect(freshnessUrgency(NOW - 72 * HOUR - 1, NOW).urgency).toBe("danger");
    expect(freshnessUrgency(NOW - 10 * DAY, NOW)).toMatchObject({ urgency: "danger", hours: 240 });
  });

  it("treats a sync time in the future (clock skew) as just synced", () => {
    expect(freshnessUrgency(NOW + HOUR, NOW)).toEqual({ urgency: "ok", hours: 0 });
  });
});

describe("urgencyClasses", () => {
  it("returns the semantic utilities of each urgency", () => {
    expect(urgencyClasses("danger")).toBe("text-danger bg-danger-soft");
    expect(urgencyClasses("warning")).toBe("text-warning bg-warning-soft");
    expect(urgencyClasses("ok")).toBe("text-positive bg-surface-2");
  });
});
