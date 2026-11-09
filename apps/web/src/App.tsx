import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AUTH_STATUS_KEY, api } from "./api";
import { Card } from "./components/ui";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";

export function App() {
  const { t } = useTranslation();
  const status = useQuery({ queryKey: AUTH_STATUS_KEY, queryFn: api.status });

  if (status.isPending) return <Card>{t("common.loading")}</Card>;
  if (status.isError) return <Card>{t("common.serverUnavailable")}</Card>;
  if (status.data.setupRequired) return <SetupPage />;
  if (!status.data.authenticated) return <LoginPage />;
  return <HomePage />;
}
