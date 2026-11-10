import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { DataRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { AppErrorBoundary } from "./app/ErrorBoundary";
import { expireSession } from "./app/RequireAuth";
import { createAppRouter } from "./app/router";
import "./i18n";
import { createQueryClient } from "./lib/query-client";
import { useThemeSync } from "./lib/theme";
import "./styles.css";

let router: DataRouter | null = null;

const queryClient = createQueryClient({
  onUnauthorized: () => {
    if (router) expireSession(router, queryClient);
  },
  onAccessDenied: () => window.location.reload(),
});

router = createAppRouter();
const appRouter = router;

function Root() {
  useThemeSync();
  return <RouterProvider router={appRouter} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Root />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
