import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type ThemePreference = "system" | "light" | "dark";
export type Density = "compact" | "comfortable";

export interface UiState {
  theme: ThemePreference;
  density: Density;
  privacy: boolean;
  sidebarCollapsed: boolean;
  setTheme(theme: ThemePreference): void;
  setDensity(density: Density): void;
  togglePrivacy(): void;
  setPrivacy(on: boolean): void;
  toggleSidebar(): void;
}

/** Browser storage key. public/theme-init.js reads the same key before first paint. */
export const UI_STORAGE_KEY = "bursar-ui";

const memory = new Map<string, string>();

/**
 * `localStorage` can be missing or throw (private windows, blocked site data). Any
 * failure falls back to an in-memory map so preferences still work for the session.
 */
export const safeStorage: StateStorage = {
  getItem(name) {
    try {
      return globalThis.localStorage.getItem(name);
    } catch {
      return memory.get(name) ?? null;
    }
  },
  setItem(name, value) {
    try {
      globalThis.localStorage.setItem(name, value);
    } catch {
      memory.set(name, value);
    }
  },
  removeItem(name) {
    try {
      globalThis.localStorage.removeItem(name);
    } catch {
      memory.delete(name);
    }
  },
};

const DEFAULTS = {
  theme: "system",
  density: "compact",
  privacy: false,
  sidebarCollapsed: false,
} as const satisfies Pick<UiState, "theme" | "density" | "privacy" | "sidebarCollapsed">;

/** Keeps only well-typed persisted values, so a hand-edited or old entry cannot break the panel. */
function sanitize(persisted: unknown): Partial<UiState> {
  if (typeof persisted !== "object" || persisted === null) return {};
  const value = persisted as Record<string, unknown>;
  const clean: Partial<UiState> = {};
  if (value.theme === "system" || value.theme === "light" || value.theme === "dark") {
    clean.theme = value.theme;
  }
  if (value.density === "compact" || value.density === "comfortable") {
    clean.density = value.density;
  }
  if (typeof value.privacy === "boolean") clean.privacy = value.privacy;
  if (typeof value.sidebarCollapsed === "boolean") clean.sidebarCollapsed = value.sidebarCollapsed;
  return clean;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      togglePrivacy: () => set((state) => ({ privacy: !state.privacy })),
      setPrivacy: (on) => set({ privacy: on }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    }),
    {
      name: UI_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        theme: state.theme,
        density: state.density,
        privacy: state.privacy,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
    },
  ),
);
