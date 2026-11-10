import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./i18n";
import { useThemeSync } from "./lib/theme";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

/** Keeps <html data-theme> and data-density in step with the stored preferences. */
function ThemeSync() {
  useThemeSync();
  return null;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
