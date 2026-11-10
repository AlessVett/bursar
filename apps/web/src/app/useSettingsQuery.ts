import { type SettingsResponse, settingsResponseSchema } from "@bursar/shared";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../api";
import i18n, { setLanguage } from "../i18n";
import { queryKeys } from "../lib/query-keys";

export const SETTINGS_STALE_MS = 5 * 60_000;

/**
 * Server settings (values and deployment facts). The response is validated so that a
 * malformed answer becomes a query error, never a crash in the shell.
 */
export function useSettingsQuery(): UseQueryResult<SettingsResponse> {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: async () => settingsResponseSchema.parse(await api.settings()),
    staleTime: SETTINGS_STALE_MS,
  });
}

/** Applies the server's language once per page load, after the settings first arrive. */
export function useLocaleSync(settings: SettingsResponse | undefined): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !settings) return;
    done.current = true;
    if (settings.values.locale !== i18n.language) setLanguage(settings.values.locale);
  }, [settings]);
}
