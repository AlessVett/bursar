import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import themeInitSource from "../../public/theme-init.js?raw";
import { useUi } from "../store/ui";
import { applyDensity, applyTheme, resolveTheme, useThemeSync } from "./theme";

/** jsdom has no matchMedia: install a controllable one. */
function installMatchMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => query),
  });
  return {
    query,
    setDark(next: boolean) {
      dark = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

function runThemeInit() {
  new Function(themeInitSource)();
}

function resetDocument() {
  const root = document.documentElement;
  delete root.dataset.theme;
  delete root.dataset.density;
  root.style.removeProperty("color-scheme");
}

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
  vi.unstubAllGlobals();
  globalThis.localStorage.clear();
  resetDocument();
  useUi.setState({ theme: "system", density: "compact" });
});

describe("resolveTheme", () => {
  it("returns an explicit choice as is and resolves system from the OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("applyTheme and applyDensity", () => {
  it("set the attributes and the color scheme on <html>", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    applyDensity("comfortable");
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });
});

describe("useThemeSync", () => {
  beforeEach(() => {
    resetDocument();
  });

  it("applies the stored theme and density", () => {
    installMatchMedia(false);
    useUi.setState({ theme: "dark", density: "comfortable" });
    renderHook(() => useThemeSync());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });

  it("follows store changes", () => {
    installMatchMedia(false);
    renderHook(() => useThemeSync());
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => useUi.getState().setTheme("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => useUi.getState().setDensity("comfortable"));
    expect(document.documentElement.dataset.density).toBe("comfortable");
  });

  it("follows the operating system while the preference is system", () => {
    const media = installMatchMedia(false);
    renderHook(() => useThemeSync());
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => media.setDark(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => useUi.getState().setTheme("light"));
    act(() => media.setDark(true));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("stops listening when unmounted", () => {
    const media = installMatchMedia(false);
    const { unmount } = renderHook(() => useThemeSync());
    expect(media.query.addEventListener).toHaveBeenCalledTimes(1);
    unmount();
    expect(media.query.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("works without matchMedia", () => {
    renderHook(() => useThemeSync());
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("public/theme-init.js", () => {
  function store(value: unknown) {
    globalThis.localStorage.setItem("bursar-ui", JSON.stringify(value));
  }

  it("uses the system theme and compact density when nothing is stored", () => {
    installMatchMedia(true);
    runThemeInit();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("applies a stored explicit theme and density without asking the system", () => {
    const media = installMatchMedia(true);
    store({ state: { theme: "light", density: "comfortable" }, version: 1 });
    runThemeInit();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.density).toBe("comfortable");
    expect(media.query.matches).toBe(true);
  });

  it("resolves a stored system theme from the OS preference", () => {
    installMatchMedia(false);
    store({ state: { theme: "system", density: "compact" }, version: 1 });
    runThemeInit();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to the defaults on corrupted or unexpected storage", () => {
    installMatchMedia(false);
    for (const raw of ["{not json", "null", "42", '{"state":{"theme":"purple","density":7}}']) {
      resetDocument();
      globalThis.localStorage.setItem("bursar-ui", raw);
      runThemeInit();
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(document.documentElement.dataset.density).toBe("compact");
    }
  });

  it("falls back to light and compact when storage and matchMedia are unavailable", () => {
    const fail = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail });
    runThemeInit();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("leaks no globals", () => {
    const before = Object.keys(globalThis);
    runThemeInit();
    expect(Object.keys(globalThis)).toEqual(before);
  });
});
