import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeStorage, UI_STORAGE_KEY, useUi } from "./ui";

const DEFAULT_PERSISTED = {
  theme: "system",
  density: "compact",
  privacy: false,
  sidebarCollapsed: false,
} as const;

function stored(): { state: Record<string, unknown>; version: number } | null {
  const raw = globalThis.localStorage.getItem(UI_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe("useUi", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    useUi.setState(DEFAULT_PERSISTED);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.localStorage.clear();
  });

  it("starts with the system theme, compact rows, visible amounts and an open sidebar", () => {
    const state = useUi.getState();
    expect(state).toMatchObject(DEFAULT_PERSISTED);
  });

  it("changes each preference through its action", () => {
    const ui = useUi.getState();
    ui.setTheme("dark");
    ui.setDensity("comfortable");
    ui.togglePrivacy();
    ui.toggleSidebar();
    expect(useUi.getState()).toMatchObject({
      theme: "dark",
      density: "comfortable",
      privacy: true,
      sidebarCollapsed: true,
    });
    ui.togglePrivacy();
    ui.toggleSidebar();
    ui.setPrivacy(true);
    expect(useUi.getState()).toMatchObject({ privacy: true, sidebarCollapsed: false });
    ui.setPrivacy(false);
    expect(useUi.getState().privacy).toBe(false);
  });

  it("persists only the four values under the bursar-ui key, version 1", () => {
    useUi.getState().setTheme("light");
    useUi.getState().setDensity("comfortable");
    expect(stored()).toEqual({
      state: { theme: "light", density: "comfortable", privacy: false, sidebarCollapsed: false },
      version: 1,
    });
  });

  it("restores a stored state", async () => {
    globalThis.localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        state: { theme: "dark", density: "comfortable", privacy: true, sidebarCollapsed: true },
        version: 1,
      }),
    );
    await useUi.persist.rehydrate();
    expect(useUi.getState()).toMatchObject({
      theme: "dark",
      density: "comfortable",
      privacy: true,
      sidebarCollapsed: true,
    });
  });

  it("ignores stored values of the wrong type or outside the allowed set", async () => {
    globalThis.localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        state: { theme: "purple", density: 42, privacy: "yes", sidebarCollapsed: true },
        version: 1,
      }),
    );
    await useUi.persist.rehydrate();
    expect(useUi.getState()).toMatchObject({
      theme: "system",
      density: "compact",
      privacy: false,
      sidebarCollapsed: true,
    });
  });

  it("keeps working when localStorage throws", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", blocked);
    expect(() => useUi.getState().setTheme("dark")).not.toThrow();
    expect(useUi.getState().theme).toBe("dark");
  });
});

describe("safeStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses localStorage when it works", () => {
    safeStorage.setItem("safe-storage-test", "a");
    expect(globalThis.localStorage.getItem("safe-storage-test")).toBe("a");
    expect(safeStorage.getItem("safe-storage-test")).toBe("a");
    safeStorage.removeItem("safe-storage-test");
    expect(safeStorage.getItem("safe-storage-test")).toBeNull();
  });

  it("falls back to memory when localStorage throws", () => {
    const fail = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail });
    safeStorage.setItem("safe-storage-memory", "b");
    expect(safeStorage.getItem("safe-storage-memory")).toBe("b");
    safeStorage.removeItem("safe-storage-memory");
    expect(safeStorage.getItem("safe-storage-memory")).toBeNull();
  });
});
