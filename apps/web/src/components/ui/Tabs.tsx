import { type KeyboardEvent, useRef } from "react";
import { cn } from "./cn";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange(id: string): void;
  ariaLabel: string;
}

export function Tabs({ items, value, onChange, ariaLabel }: TabsProps) {
  const list = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key) || items.length === 0) return;
    event.preventDefault();
    const current = Math.max(
      0,
      items.findIndex((item) => item.id === value),
    );
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % items.length;
    if (event.key === "ArrowLeft") next = (current - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    const target = items[next];
    if (!target) return;
    onChange(target.id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="flex gap-1 overflow-x-auto border-b border-subtle"
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={cn(
              "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors max-sm:min-h-11",
              selected
                ? "border-primary font-semibold text-fg"
                : "border-transparent text-muted hover:text-fg",
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className="tabular text-xs text-muted">{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
