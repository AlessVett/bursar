import { CornerDownLeft, Search } from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { normalizeForSearch } from "../lib/search";
import { PALETTE_SOURCES, type PaletteItem } from "./palette-sources";

interface PaletteControl {
  isOpen: boolean;
  open(): void;
  close(): void;
}

const PaletteContext = createContext<PaletteControl | null>(null);

/** Holds the palette's open state for the shell, the topbar trigger and the ⌘K shortcut. */
export function PaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);
  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}

export function usePaletteControl(): PaletteControl {
  const control = useContext(PaletteContext);
  if (!control) throw new Error("usePaletteControl must be used inside PaletteProvider");
  return control;
}

interface PaletteResults {
  groups: { name: string; items: PaletteItem[] }[];
  flat: PaletteItem[];
  loading: boolean;
}

function usePaletteResults(query: string): PaletteResults {
  const normalized = normalizeForSearch(query);
  const perSource = PALETTE_SOURCES.map((source) => ({
    source,
    // biome-ignore lint/correctness/useHookAtTopLevel: PALETTE_SOURCES is a module constant, so every render calls the same hooks in the same order.
    result: source.useItems(normalized),
  }));
  const groups: PaletteResults["groups"] = [];
  const flat: PaletteItem[] = [];
  let loading = false;
  for (const { source, result } of perSource) {
    if (normalized.length < source.minQueryLength) continue;
    loading ||= result.loading;
    const items = result.items.slice(0, source.limit);
    if (items.length === 0) continue;
    groups.push({ name: items[0]?.group ?? source.id, items });
    flat.push(...items);
  }
  return { groups, flat, loading };
}

/**
 * The ⌘K command palette: a modal dialog with a combobox and a listbox of results from
 * `PALETTE_SOURCES`. ↑↓ move, ↵ opens, Esc closes; focus returns to where it was.
 */
export function CommandPalette() {
  const { isOpen, close } = usePaletteControl();
  if (!isOpen) return null;
  return <PaletteDialog onClose={close} />;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const listboxId = useId();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { groups, flat, loading } = usePaletteResults(query);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const activeItem = activeIndex >= 0 ? flat[activeIndex] : undefined;

  function optionId(index: number): string {
    return `${listboxId}-option-${index}`;
  }

  function openItem(item: PaletteItem) {
    onClose();
    navigate(item.to);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeItem) openItem(activeItem);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      // The input is the only focusable element of the dialog: keep focus inside it.
      event.preventDefault();
    }
  }

  let index = -1;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-fg/30 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-subtle bg-surface shadow-xl"
      >
        <h2 id={titleId} className="sr-only">
          {t("palette.title")}
        </h2>
        <div className="flex items-center gap-3 border-b border-subtle px-4">
          <Search aria-hidden size={18} strokeWidth={1.75} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-label={t("palette.inputLabel")}
            placeholder={t("palette.placeholder")}
            autoComplete="off"
            spellCheck={false}
            className="h-14 w-full bg-transparent text-base text-fg outline-none placeholder:text-muted"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div
          id={listboxId}
          role="listbox"
          aria-label={t("palette.resultsLabel")}
          aria-busy={loading ? "true" : undefined}
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {groups.map((group) => (
            <div key={group.name} role="presentation" className="pb-1">
              <div
                role="presentation"
                className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted"
              >
                {group.name}
              </div>
              {group.items.map((item) => {
                index += 1;
                const itemIndex = index;
                const selected = itemIndex === activeIndex;
                const Icon = item.icon;
                return (
                  <div
                    key={item.id}
                    id={optionId(itemIndex)}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 ${
                      selected ? "bg-primary-50 text-primary" : "text-fg"
                    }`}
                    onMouseMove={() => {
                      if (!selected) setActive(itemIndex);
                    }}
                    onClick={() => openItem(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") openItem(item);
                    }}
                  >
                    <Icon aria-hidden size={18} strokeWidth={1.75} className="shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="block truncate text-xs text-muted">{item.subtitle}</span>
                    </span>
                    {item.trailing ? <span className="shrink-0">{item.trailing}</span> : null}
                    {selected ? (
                      <CornerDownLeft aria-hidden size={16} className="shrink-0 text-muted" />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {flat.length === 0 && !loading && query.trim().length > 0 ? (
          <div className="px-6 pb-8 pt-2 text-center">
            <p className="text-sm font-medium text-fg">
              {t("palette.empty", { query: query.trim() })}
            </p>
            <p className="mt-1 text-sm text-muted">{t("palette.emptyHint")}</p>
          </div>
        ) : null}
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-subtle px-4 py-2 text-xs text-muted"
          aria-live="polite"
        >
          {t("palette.footer", { count: flat.length })}
        </div>
      </div>
    </div>
  );
}
