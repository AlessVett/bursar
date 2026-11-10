import { type RefObject, useEffect } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * While `active`, moves focus into `ref`, keeps Tab and Shift+Tab inside it and, when it turns
 * inactive or unmounts, gives focus back to the element that had it before. The Tab listener is
 * a native one on the container, so a dialog portalled out of it does not fight with it.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (focusableWithin(root)[0] ?? root).focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Tab" || !root) return;
      const items = focusableWithin(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        root.focus();
        return;
      }
      const current = document.activeElement;
      if (!root.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (current === first || current === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, active]);
}

let scrollLocks = 0;
let savedOverflow = "";

/** Stops the page behind a drawer or dialog from scrolling; nested overlays share one lock. */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (scrollLocks === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLocks += 1;
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = savedOverflow;
    };
  }, [active]);
}
