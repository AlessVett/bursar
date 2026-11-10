import {
  SETTINGS_DEFAULTS,
  type SettingsPatch,
  type SettingsValues,
  settingsPatchSchema,
  settingsValuesSchema,
} from "@bursar/shared";
import type { BursarDb } from "../db";
import { settings } from "../db/schema";

const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS) as (keyof SettingsValues)[];

/**
 * Owner settings, one row per key with a JSON value. A missing row, invalid JSON, an unknown
 * key or a value that no longer passes its schema all read as the default for that key, so a
 * damaged row can never stop the service from starting or a page from loading.
 */
export class SettingsStore {
  constructor(
    private readonly db: BursarDb,
    private readonly now: () => number = Date.now,
  ) {}

  get(): SettingsValues {
    const stored = new Map(
      this.db
        .select()
        .from(settings)
        .all()
        .map((row) => [row.key, row.value]),
    );
    const values: Record<string, unknown> = { ...SETTINGS_DEFAULTS };
    for (const key of SETTINGS_KEYS) {
      const raw = stored.get(key);
      if (raw === undefined) continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(raw);
      } catch {
        continue;
      }
      const parsed = settingsValuesSchema.shape[key].safeParse(candidate);
      if (parsed.success) values[key] = parsed.data;
    }
    return values as SettingsValues;
  }

  /**
   * Applies a patch. Only keys whose effective value changes are written, all in one
   * transaction, and `changed` lists them in schema order. Throws a `ZodError` for a patch
   * that does not satisfy `settingsPatchSchema`; nothing is written in that case.
   */
  update(patch: SettingsPatch): { values: SettingsValues; changed: (keyof SettingsValues)[] } {
    const valid = settingsPatchSchema.parse(patch);
    return this.db.transaction((tx) => {
      const current = this.get();
      const changed: (keyof SettingsValues)[] = [];
      const at = this.now();
      for (const key of SETTINGS_KEYS) {
        const next = valid[key];
        if (next === undefined || next === current[key]) continue;
        const value = JSON.stringify(next);
        tx.insert(settings)
          .values({ key, value, updatedAt: at })
          .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: at } })
          .run();
        changed.push(key);
      }
      return { values: this.get(), changed };
    });
  }
}
