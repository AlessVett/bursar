import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

const URL_CHANGE_EVENT = "bursar:urlchange";

export interface UrlStateOptions<T extends Record<string, string>> {
  /** Per-key validators; a value that fails its validator falls back to the default. */
  validate?: Partial<Record<keyof T, (value: string) => boolean>>;
  /** Keys (such as `page`) that return to their default when any other key changes. */
  resetOnChange?: (keyof T)[];
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(URL_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(URL_CHANGE_EVENT, onChange);
  };
}

function currentSearch(): string {
  return window.location.search;
}

function serverSearch(): string {
  return "";
}

function parse<T extends Record<string, string>>(
  search: string,
  defaults: T,
  validate: UrlStateOptions<T>["validate"],
): T {
  const params = new URLSearchParams(search);
  const result: Record<string, string> = {};
  for (const key of Object.keys(defaults)) {
    const fallback = defaults[key] as string;
    const raw = params.get(key);
    const usable = raw !== null && (raw !== "" || fallback === "");
    const valid = usable && (validate?.[key]?.(raw) ?? true);
    result[key] = valid ? raw : fallback;
  }
  return result as T;
}

/**
 * Filters, tabs and the selected period live in the URL. Writes use `history.replaceState`
 * (never a new history entry), a value equal to its default is removed from the URL, an invalid
 * value reads as the default, and parameters this hook does not know about are left alone.
 */
export function useUrlState<T extends Record<string, string>>(
  defaults: T,
  options: UrlStateOptions<T> = {},
): [T, (patch: Partial<T>) => void] {
  const search = useSyncExternalStore(subscribe, currentSearch, serverSearch);
  const latest = useRef({ defaults, options });
  latest.current = { defaults, options };

  const defaultsKey = JSON.stringify(defaults);
  // biome-ignore lint/correctness/useExhaustiveDependencies: defaults are compared by value through defaultsKey, validators are read from the latest render
  const state = useMemo(
    () => parse(search, latest.current.defaults, latest.current.options.validate),
    [search, defaultsKey],
  );

  const update = useCallback((patch: Partial<T>) => {
    const { defaults: base, options: opts } = latest.current;
    const before = window.location.search;
    const current = parse(before, base, opts.validate);
    const next: Record<string, string> = { ...current };
    let changedOther = false;
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      if (value === undefined || !(key in base)) continue;
      if (value !== current[key]) {
        next[key] = value;
        if (!opts.resetOnChange?.includes(key)) changedOther = true;
      }
    }
    if (changedOther) {
      for (const key of opts.resetOnChange ?? []) {
        if (!(key in patch)) next[key as string] = base[key as string] as string;
      }
    }
    const params = new URLSearchParams(before);
    for (const key of Object.keys(base)) {
      const value = next[key] as string;
      const valid = opts.validate?.[key]?.(value) ?? true;
      if (!valid || value === base[key]) params.delete(key);
      else params.set(key, value);
    }
    const after = params.toString();
    if (after === before.replace(/^\?/, "")) return;
    const url = `${window.location.pathname}${after ? `?${after}` : ""}${window.location.hash}`;
    window.history.replaceState(window.history.state, "", url);
    window.dispatchEvent(new Event(URL_CHANGE_EVENT));
  }, []);

  return [state, update];
}
