// Runs synchronously from <head>, before the first paint, so the panel never flashes
// the wrong theme. It must stay a classic script without globals: the CSP allows
// `script-src 'self'` only. The stored shape is written by src/store/ui.ts
// ({ state: { theme, density }, version }).
(() => {
  const root = document.documentElement;
  let theme = "system";
  let density = "compact";
  try {
    const stored = JSON.parse(window.localStorage.getItem("bursar-ui") ?? "null");
    const state = stored?.state;
    if (state?.theme === "light" || state?.theme === "dark" || state?.theme === "system") {
      theme = state.theme;
    }
    if (state?.density === "compact" || state?.density === "comfortable") {
      density = state.density;
    }
  } catch {
    // Storage unavailable or corrupted: keep the defaults.
  }
  let dark = theme === "dark";
  if (theme === "system") {
    try {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      dark = false;
    }
  }
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.density = density;
})();
