import type { ServerEvent } from "@bursar/shared";

type Listener = (event: ServerEvent) => void;

/** In-process publish/subscribe for the events the panel receives over SSE. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  /** `onListenerError` is told about a listener that threw; the other listeners still run. */
  constructor(private readonly onListenerError: (error: unknown) => void = () => {}) {}

  publish(event: ServerEvent): void {
    // Iterate a copy: a listener may unsubscribe itself (or another) while being notified.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  /** Registers a listener and returns the function that removes it (safe to call twice). */
  subscribe(listener: Listener): () => void {
    // A fresh wrapper per subscription, so subscribing the same function twice stays independent.
    const entry: Listener = (event) => listener(event);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}
