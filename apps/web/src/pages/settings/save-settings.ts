import { type SettingsPatch, type SettingsResponse, settingsValuesSchema } from "@bursar/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../../api";
import { feedback } from "../../components/feedback";
import i18n from "../../i18n";
import { isSessionExpired } from "../../lib/query-client";
import { queryKeys } from "../../lib/query-keys";
import { SectionFormError } from "./useSectionForm";

export type SectionId = "general" | "banking" | "notifications" | "display" | "backups";

interface FieldSchema {
  safeParse(value: unknown): { success: boolean };
}

const FIELD_SCHEMAS: Readonly<Record<string, FieldSchema>> = settingsValuesSchema.shape;

/**
 * Checks each field of a patch with the same Zod schema the server applies and returns a
 * `SectionFormError` with a translated message per invalid field, or null. The server's 400 does
 * not name fields (Task 8), so this is where "errors next to the fields" come from.
 */
export function validateSettingsFields(patch: SettingsPatch): SectionFormError | null {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    const schema = FIELD_SCHEMAS[key];
    if (!schema || schema.safeParse(value).success) continue;
    fields[key] = i18n.t(`settings.errors.${key}`, {
      defaultValue: i18n.t("settings.errors.generic"),
    });
  }
  return Object.keys(fields).length > 0 ? new SectionFormError(fields) : null;
}

/**
 * The one path every section saves through: validate, PATCH, put the response in the `settings`
 * query, run `afterSave`, then confirm with a toast that names the section. Failures are reported
 * here (toast) and rethrown for `useSectionForm`, which keeps the section in edit mode. A 401 is
 * left to the query client's session-expiry handler.
 */
export function useSaveSettings() {
  const queryClient = useQueryClient();
  const mutation = useMutation({ mutationFn: (patch: SettingsPatch) => api.updateSettings(patch) });

  return async (
    section: SectionId,
    patch: SettingsPatch,
    afterSave?: () => void,
  ): Promise<void> => {
    const invalid = validateSettingsFields(patch);
    if (invalid) {
      feedback(
        i18n.t("settings.invalid.title"),
        i18n.t("settings.invalid.detail", { count: Object.keys(invalid.fields).length }),
        "warning",
      );
      throw invalid;
    }
    let response: SettingsResponse;
    try {
      response = await mutation.mutateAsync(patch);
    } catch (error) {
      if (isSessionExpired(error)) throw error;
      if (error instanceof ApiError && error.status === 400) {
        feedback(i18n.t("settings.invalid.title"), i18n.t("settings.invalid.refused"), "warning");
        throw new SectionFormError({});
      }
      feedback(i18n.t("settings.saveFailed.title"), i18n.t("settings.saveFailed.detail"), "error");
      throw error;
    }
    queryClient.setQueryData(queryKeys.settings, response);
    afterSave?.();
    // After `afterSave`: a language change must already apply to the confirmation.
    feedback(
      i18n.t("settings.saved.title"),
      i18n.t("settings.saved.detail", {
        section: i18n.t(`settings.sections.${section}.title`),
      }),
    );
  };
}
