import { useEffect, useState } from "react";
import { type Density, type ThemePreference, useUi } from "../store/ui";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): "light" | "dark" {
  if (pref === "system") return prefersDark ? "dark" : "light";
  return pref;
}

export function applyTheme(resolved: "light" | "dark"): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
}

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null;
}

/**
 * Keeps `data-theme` and `data-density` on <html> in step with the UI store and with the
 * operating system preference. public/theme-init.js already set both before first paint.
 */
export function useThemeSync(): void {
  const theme = useUi((state) => state.theme);
  const density = useUi((state) => state.density);
  const [prefersDark, setPrefersDark] = useState(() => darkQuery()?.matches ?? false);

  useEffect(() => {
    const query = darkQuery();
    if (!query) return;
    setPrefersDark(query.matches);
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyTheme(resolveTheme(theme, prefersDark));
  }, [theme, prefersDark]);

  useEffect(() => {
    applyDensity(density);
  }, [density]);
}
