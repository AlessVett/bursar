import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";

export interface UrlStateOptions<T extends Record<string, string>> {
  validate?: Partial<Record<keyof T, (value: string) => boolean>>;
  resetOnChange?: (keyof T)[];
}

/**
 * Filters, tabs and periods kept in the query string. Default values are absent from the URL, an
 * invalid value reads as its default, writes use `replace`, and the keys in `resetOnChange` (for
 * example `page`) return to their default whenever another key changes. Unknown parameters are kept.
 */
export function useUrlState<T extends Record<string, string>>(
  defaults: T,
  options: UrlStateOptions<T> = {},
): [T, (patch: Partial<T>) => void] {
  const [params, setParams] = useSearchParams();
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const search = params.toString();
  const defaultsKey = JSON.stringify(defaults);
  // biome-ignore lint/correctness/useExhaustiveDependencies: values change only when the query string or the defaults change; the refs hold the latest objects.
  const values = useMemo(() => {
    const current = new URLSearchParams(search);
    const result = { ...defaultsRef.current };
    for (const key of Object.keys(result) as (keyof T & string)[]) {
      const raw = current.get(key);
      if (raw === null) continue;
      const isValid = optionsRef.current.validate?.[key];
      if (!isValid || isValid(raw)) result[key] = raw as T[keyof T & string];
    }
    return result;
  }, [search, defaultsKey]);

  const update = useCallback(
    (patch: Partial<T>) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          const fallback = defaultsRef.current;
          const reset = (optionsRef.current.resetOnChange ?? []) as string[];
          let otherChanged = false;
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            const before = previous.get(key) ?? fallback[key];
            if (value === fallback[key]) next.delete(key);
            else next.set(key, value);
            if (!reset.includes(key) && before !== value) otherChanged = true;
          }
          if (otherChanged) {
            for (const key of reset) if (!(key in patch)) next.delete(key);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return [values, update];
}
