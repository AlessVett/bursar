import type { ServerEvent } from "@bursar/shared";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus";

const event: ServerEvent = { type: "sync.progress", accountId: 1, fetched: 10 };

describe("EventBus", () => {
  it("delivers an event to every subscriber in subscription order", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(`a:${e.type}`));
    bus.subscribe((e) => seen.push(`b:${e.type}`));
    bus.publish(event);
    expect(seen).toEqual(["a:sync.progress", "b:sync.progress"]);
    expect(bus.listenerCount()).toBe(2);
  });

  it("stops delivering after unsubscribe, which is safe to call twice", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();
    unsubscribe();
    bus.publish(event);
    expect(listener).not.toHaveBeenCalled();
    expect(bus.listenerCount()).toBe(0);
  });

  it("keeps notifying the others when a listener throws, and reports the error", () => {
    const onError = vi.fn();
    const bus = new EventBus(onError);
    const after = vi.fn();
    bus.subscribe(() => {
      throw new Error("listener bug");
    });
    bus.subscribe(after);
    expect(() => bus.publish(event)).not.toThrow();
    expect(after).toHaveBeenCalledWith(event);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "listener bug" }));
  });

  it("survives a listener that unsubscribes while being notified", () => {
    const bus = new EventBus();
    const second = vi.fn();
    const unsubscribeFirst = bus.subscribe(() => unsubscribeFirst());
    bus.subscribe(second);
    bus.publish(event);
    expect(second).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount()).toBe(1);
  });

  it("treats the same function subscribed twice as two subscriptions", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const first = bus.subscribe(listener);
    bus.subscribe(listener);
    first();
    bus.publish(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("has no listeners initially and ignores publishing to nobody", () => {
    const bus = new EventBus();
    expect(bus.listenerCount()).toBe(0);
    expect(() => bus.publish(event)).not.toThrow();
  });
});
