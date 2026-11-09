import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AUTH_STATUS_KEY, api } from "../api";
import { LanguageSwitcher } from "../components/LanguageSwitcher";

export function HomePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY }),
  });

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <span className="text-lg font-semibold">{t("app.name")}</span>
        <div className="flex items-center gap-4">
          <LanguageSwitcher />
          <button
            type="button"
            className="text-sm font-medium text-slate-700 hover:text-slate-900"
            onClick={() => logout.mutate()}
          >
            {t("home.logout")}
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="mb-2 text-2xl font-semibold">{t("home.welcome")}</h1>
        <p className="text-slate-600">{t("home.empty")}</p>
      </main>
    </div>
  );
}
