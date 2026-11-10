import { SETTINGS_DEFAULTS } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { SettingsStore } from "./store";

describe("SettingsStore", () => {
  let t: TestDatabase;
  let now: number;
  let store: SettingsStore;

  const rows = () =>
    t.sqlite
      .prepare("SELECT key, value, updated_at AS updatedAt FROM settings ORDER BY key")
      .all() as {
      key: string;
      value: string;
      updatedAt: number;
    }[];
  const insertRaw = (key: string, value: string) =>
    t.sqlite
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, value, now);

  beforeEach(() => {
    t = createTestDatabase();
    now = Date.UTC(2026, 10, 9, 9, 0, 0);
    store = new SettingsStore(t.db, () => now);
  });
  afterEach(() => t.dispose());

  it("returns the defaults on an empty table without writing anything", () => {
    expect(store.get()).toEqual(SETTINGS_DEFAULTS);
    expect(rows()).toEqual([]);
  });

  it("stores only the keys that change, as JSON, with the update time", () => {
    const result = store.update({ consentDays: 90, notificationEmail: "owner@example.test" });
    expect(result.changed).toEqual(["consentDays", "notificationEmail"]);
    expect(result.values).toEqual({
      ...SETTINGS_DEFAULTS,
      consentDays: 90,
      notificationEmail: "owner@example.test",
    });
    expect(rows()).toEqual([
      { key: "consentDays", value: "90", updatedAt: now },
      { key: "notificationEmail", value: '"owner@example.test"', updatedAt: now },
    ]);
    expect(store.get()).toEqual(result.values);
  });

  it("merges later patches and leaves the other keys alone", () => {
    store.update({ consentDays: 90 });
    now += 60_000;
    store.update({ locale: "en", country: "IT" });
    expect(store.get()).toEqual({
      ...SETTINGS_DEFAULTS,
      consentDays: 90,
      locale: "en",
      country: "IT",
    });
    expect(rows().find((row) => row.key === "consentDays")?.updatedAt).toBe(now - 60_000);
    expect(rows().find((row) => row.key === "locale")?.updatedAt).toBe(now);
  });

  it("reports no change and writes nothing for an empty patch or unchanged values", () => {
    expect(store.update({})).toEqual({ values: SETTINGS_DEFAULTS, changed: [] });
    expect(
      store.update({ consentDays: 180, emailNotifications: true, country: null }).changed,
    ).toEqual([]);
    expect(rows()).toEqual([]);
    store.update({ consentDays: 90 });
    now += 1_000;
    expect(store.update({ consentDays: 90 }).changed).toEqual([]);
    expect(rows()).toEqual([{ key: "consentDays", value: "90", updatedAt: now - 1_000 }]);
  });

  it("changes a value back to null and back to a default", () => {
    store.update({ country: "IT", highlightNegativeNet: false });
    const result = store.update({ country: null, highlightNegativeNet: true });
    expect(result.changed).toEqual(["country", "highlightNegativeNet"]);
    expect(result.values).toEqual(SETTINGS_DEFAULTS);
  });

  it("lists the changed keys in schema order", () => {
    expect(
      store.update({ highlightNegativeNet: false, locale: "en", backupTime: "04:30" }).changed,
    ).toEqual(["locale", "backupTime", "highlightNegativeNet"]);
  });

  it("falls back to the default for a stored value that is not valid JSON", () => {
    insertRaw("consentDays", "{not json");
    insertRaw("locale", '"en"');
    expect(store.get()).toEqual({ ...SETTINGS_DEFAULTS, locale: "en" });
  });

  it("falls back to the default for a stored value that fails its schema", () => {
    insertRaw("consentDays", "9000");
    insertRaw("backgroundSyncCap", "2.5");
    insertRaw("dailySyncTime", '"25:61"');
    insertRaw("country", '"it"');
    insertRaw("notificationEmail", '"not-an-email"');
    insertRaw("emailNotifications", '"yes"');
    insertRaw("locale", '"fr"');
    expect(store.get()).toEqual(SETTINGS_DEFAULTS);
  });

  it("ignores rows for unknown keys", () => {
    insertRaw("retiredSetting", "true");
    insertRaw("__proto__", '{"polluted":true}');
    expect(store.get()).toEqual(SETTINGS_DEFAULTS);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("overwrites a damaged row when the key is updated", () => {
    insertRaw("consentDays", "{not json");
    const result = store.update({ consentDays: 120 });
    expect(result.changed).toEqual(["consentDays"]);
    expect(rows()).toEqual([{ key: "consentDays", value: "120", updatedAt: now }]);
  });

  it("rejects an invalid patch and writes nothing, not even the valid keys", () => {
    expect(() => store.update({ consentDays: 90, backgroundSyncCap: 5 })).toThrow();
    expect(() => store.update({ unknownKey: true } as never)).toThrow();
    expect(rows()).toEqual([]);
  });

  it("rolls back every key when a write fails midway", () => {
    t.sqlite.exec(
      "CREATE TRIGGER fail_on_locale BEFORE INSERT ON settings WHEN NEW.key = 'locale' BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    );
    expect(() => store.update({ consentDays: 90, locale: "en" })).toThrow(/forced failure/);
    expect(rows()).toEqual([]);
    expect(store.get()).toEqual(SETTINGS_DEFAULTS);
  });

  it("is shared by two store instances over the same database", () => {
    new SettingsStore(t.db, () => now).update({ consentDays: 60 });
    expect(store.get().consentDays).toBe(60);
  });
});
