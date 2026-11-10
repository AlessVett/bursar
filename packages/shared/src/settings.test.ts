import { describe, expect, it } from "vitest";
import {
  SETTINGS_DEFAULTS,
  settingsPatchSchema,
  settingsResponseSchema,
  settingsValuesSchema,
  timeOfDaySchema,
} from "./settings";

describe("timeOfDaySchema", () => {
  it.each(["00:00", "06:00", "09:05", "19:59", "23:59"])("accepts %s", (value) => {
    expect(timeOfDaySchema.safeParse(value).success).toBe(true);
  });

  it.each(["24:00", "23:60", "6:00", "06:0", "0600", "06:00:00", " 06:00", "ab:cd", ""])(
    "rejects %j",
    (value) => {
      expect(timeOfDaySchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("SETTINGS_DEFAULTS", () => {
  it("satisfies the values schema", () => {
    expect(settingsValuesSchema.parse(SETTINGS_DEFAULTS)).toEqual(SETTINGS_DEFAULTS);
  });

  it("holds the documented defaults", () => {
    expect(SETTINGS_DEFAULTS).toEqual({
      locale: "it",
      country: null,
      consentDays: 180,
      backgroundSyncCap: 2,
      dailySyncTime: "06:00",
      backupTime: "03:00",
      notificationEmail: null,
      emailNotifications: true,
      highlightNegativeNet: true,
    });
  });
});

describe("settingsValuesSchema", () => {
  const valid = { ...SETTINGS_DEFAULTS, country: "IT", notificationEmail: "owner@example.test" };

  it("accepts a fully populated document", () => {
    expect(settingsValuesSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["locale", "fr"],
    ["country", "it"],
    ["country", "ITA"],
    ["country", ""],
    ["consentDays", 0],
    ["consentDays", 366],
    ["consentDays", 90.5],
    ["backgroundSyncCap", 0],
    ["backgroundSyncCap", 5],
    ["dailySyncTime", "7am"],
    ["backupTime", "25:00"],
    ["notificationEmail", "not-an-email"],
    ["notificationEmail", `${"a".repeat(250)}@example.test`],
    ["emailNotifications", "yes"],
    ["highlightNegativeNet", 1],
  ])("rejects %s = %j", (key, value) => {
    expect(settingsValuesSchema.safeParse({ ...valid, [key]: value }).success).toBe(false);
  });

  it("accepts the range limits", () => {
    for (const patch of [
      { consentDays: 1 },
      { consentDays: 365 },
      { backgroundSyncCap: 1 },
      { backgroundSyncCap: 4 },
    ]) {
      expect(settingsValuesSchema.safeParse({ ...valid, ...patch }).success).toBe(true);
    }
  });
});

describe("settingsPatchSchema", () => {
  it("accepts an empty patch and any subset", () => {
    expect(settingsPatchSchema.safeParse({}).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ consentDays: 90 }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ notificationEmail: null, country: null }).success).toBe(
      true,
    );
  });

  it("rejects unknown keys", () => {
    expect(settingsPatchSchema.safeParse({ consentdays: 90 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ consentDays: 90, extra: true }).success).toBe(false);
  });

  it("validates each provided value like the full schema", () => {
    expect(settingsPatchSchema.safeParse({ backgroundSyncCap: 5 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ dailySyncTime: "6:00" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ notificationEmail: "nope" }).success).toBe(false);
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, [], "locale", 3]) {
      expect(settingsPatchSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("settingsResponseSchema", () => {
  it("accepts the response shape", () => {
    const response = {
      values: SETTINGS_DEFAULTS,
      system: {
        timezone: "Europe/Rome",
        publicUrl: "https://bursar.example.test",
        enableBankingConfigured: true,
        smtpConfigured: false,
        backupTarget: "local",
      },
    };
    expect(settingsResponseSchema.parse(response)).toEqual(response);
    expect(
      settingsResponseSchema.safeParse({
        ...response,
        system: { ...response.system, backupTarget: "ftp" },
      }).success,
    ).toBe(false);
  });
});
