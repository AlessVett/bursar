import { z } from "zod";

/** A wall-clock time of day, `HH:MM`, 00:00 to 23:59. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM between 00:00 and 23:59");

export const settingsValuesSchema = z.object({
  locale: z.enum(["it", "en"]),
  /** ISO 3166-1 alpha-2 code of the preselected bank country in the connect flow. */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  /** Requested consent length in days; the connect flow caps it at the bank's maximum. */
  consentDays: z.number().int().min(1).max(365),
  /** Background fetches allowed per account and local day (the PSD2 limit is 4 a day). */
  backgroundSyncCap: z.number().int().min(1).max(4),
  dailySyncTime: timeOfDaySchema,
  backupTime: timeOfDaySchema,
  notificationEmail: z.string().email().max(254).nullable(),
  emailNotifications: z.boolean(),
  highlightNegativeNet: z.boolean(),
});
export type SettingsValues = z.infer<typeof settingsValuesSchema>;

export const SETTINGS_DEFAULTS: SettingsValues = {
  locale: "it",
  country: null,
  consentDays: 180,
  backgroundSyncCap: 2,
  dailySyncTime: "06:00",
  backupTime: "03:00",
  notificationEmail: null,
  emailNotifications: true,
  highlightNegativeNet: true,
};

/** Any subset of the settings; unknown keys are rejected so a typo never passes silently. */
export const settingsPatchSchema = settingsValuesSchema.partial().strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const settingsResponseSchema = z.object({
  values: settingsValuesSchema,
  /** Read-only facts about the deployment, shown on the Settings page. */
  system: z.object({
    timezone: z.string(),
    publicUrl: z.string(),
    enableBankingConfigured: z.boolean(),
    smtpConfigured: z.boolean(),
    backupTarget: z.enum(["s3", "local"]),
  }),
});
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;
