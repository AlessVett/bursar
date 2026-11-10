import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface SearchInputProps {
  /** The committed value (usually from the URL). */
  value: string;
  onChange(value: string): void;
  placeholder: string;
  /** Accessible name of the field. */
  label: string;
  debounceMs?: number;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  debounceMs = 250,
}: SearchInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  useEffect(() => () => clearTimeout(timer.current), []);

  function commit(next: string): void {
    clearTimeout(timer.current);
    if (next === committed.current) return;
    committed.current = next;
    onChange(next);
  }

  function edit(next: string): void {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(next), debounceMs);
  }

  return (
    <div className="relative">
      <Search
        aria-hidden
        size={16}
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(draft);
          if (event.key === "Escape" && draft !== "") {
            setDraft("");
            commit("");
          }
        }}
        className="h-10 w-full rounded-lg border border-subtle bg-surface pr-9 pl-9 text-sm text-fg placeholder:text-muted max-sm:h-11 [&::-webkit-search-cancel-button]:hidden"
      />
      {draft !== "" ? (
        <button
          type="button"
          aria-label={t("table.clearSearch")}
          onClick={() => {
            setDraft("");
            commit("");
          }}
          className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg max-sm:size-9"
        >
          <X aria-hidden size={14} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
