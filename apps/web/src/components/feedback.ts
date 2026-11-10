import { useIsMutating } from "@tanstack/react-query";
import { create } from "zustand";

export type FeedbackTone = "success" | "info" | "warning" | "error";

export interface Toast {
  id: number;
  title: string;
  detail?: string;
  tone: FeedbackTone;
}

const AUTO_DISMISS_MS = 4000;
const PULSE_MS = 1000;
const MAX_TOASTS = 5;

interface FeedbackState {
  toasts: Toast[];
  pulses: number;
}

const useFeedbackStore = create<FeedbackState>()(() => ({ toasts: [], pulses: 0 }));
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

function forgetTimer(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

export function dismissToast(id: number): void {
  forgetTimer(id);
  useFeedbackStore.setState((state) => ({
    toasts: state.toasts.filter((toast) => toast.id !== id),
  }));
}

/** Removes every toast. Used by tests and when the session ends. */
export function clearToasts(): void {
  for (const id of [...timers.keys()]) forgetTimer(id);
  useFeedbackStore.setState({ toasts: [], pulses: 0 });
}

/**
 * The only way the panel shows the result of an action: a toast at the top right, plus a one
 * second pulse of the save indicator.
 *
 * Grammar (UX doc §7): `title` names the outcome ("Account renamed", "Sync started"); `detail`
 * names the real object and the consequence ("Main account is now called Household", "New
 * transactions appear in a minute"). Never an id, an IBAN or a remittance text.
 *
 * Tones: `success` for something already done (default); `info` for background work;
 * `warning` for a refusal or a restrictive consequence; `error` only for real errors. Success,
 * info and warning disappear after 4 seconds, an error stays until it is closed.
 */
export function feedback(title: string, detail?: string, tone: FeedbackTone = "success"): void {
  const id = nextId++;
  const toast: Toast = detail === undefined ? { id, title, tone } : { id, title, detail, tone };
  const kept = useFeedbackStore.getState().toasts;
  const overflow = kept.slice(0, Math.max(0, kept.length + 1 - MAX_TOASTS));
  for (const old of overflow) forgetTimer(old.id);
  useFeedbackStore.setState((state) => ({
    toasts: [...state.toasts.slice(overflow.length), toast],
    pulses: state.pulses + 1,
  }));
  setTimeout(() => {
    useFeedbackStore.setState((state) => ({ pulses: Math.max(0, state.pulses - 1) }));
  }, PULSE_MS);
  if (tone !== "error")
    timers.set(
      id,
      setTimeout(() => dismissToast(id), AUTO_DISMISS_MS),
    );
}

export function useToasts(): Toast[] {
  return useFeedbackStore((state) => state.toasts);
}

/** "saving" while a mutation is in flight or for one second after a toast; otherwise "saved". */
export function useSaveState(): "saved" | "saving" {
  const mutating = useIsMutating();
  const pulsing = useFeedbackStore((state) => state.pulses > 0);
  return mutating > 0 || pulsing ? "saving" : "saved";
}
