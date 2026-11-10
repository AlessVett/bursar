import type { ServerEvent } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_IDLE_MS, SessionStore } from "../auth/sessions";
import { EventBus } from "../events/bus";
import { createTestApp, type TestApp } from "../test/app";
import { createTestDatabase, type TestDatabase } from "../test/db";
import { type EventsRouteDeps, eventsRoute } from "./events";

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms} ms ${what}`)), ms),
    ),
  ]);

/** Reads a streaming response incrementally and remembers everything received. */
function collect(response: Response) {
  if (!response.body) throw new Error("response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    get text() {
      return text;
    },
    async until(needle: string, timeoutMs = 2_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!text.includes(needle)) {
        const chunk = await withTimeout(
          reader.read(),
          Math.max(1, deadline - Date.now()),
          `waiting for ${needle}`,
        );
        if (chunk.done) throw new Error(`Stream ended before ${needle}; received ${text}`);
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
    async ended(timeoutMs = 2_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const chunk = await withTimeout(
          reader.read(),
          Math.max(1, deadline - Date.now()),
          "waiting for the stream to end",
        );
        if (chunk.done) return true;
        text += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

const progress = (fetched: number): ServerEvent => ({
  type: "sync.progress",
  accountId: 1,
  fetched,
});

describe("eventsRoute", () => {
  let t: TestDatabase;
  let now: number;
  let bus: EventBus;
  let ta: TestApp;
  let streams: ReturnType<typeof collect>[];

  async function setup(options: Partial<EventsRouteDeps> = {}) {
    const sessions = new SessionStore(t.db, () => now);
    ta = await createTestApp({
      database: t,
      now: () => now,
      routers: [
        {
          prefix: "/api/events",
          router: eventsRoute({ bus, sessions, heartbeatMs: 25, ...options }),
        },
      ],
    });
  }

  async function open(init: RequestInit = {}) {
    const response = await ta.app.request("/api/events", {
      ...init,
      headers: { cookie: ta.cookie, ...(init.headers as Record<string, string> | undefined) },
    });
    return response;
  }

  async function connect() {
    const stream = collect(await open());
    streams.push(stream);
    await stream.until("event: ready\ndata: {}\n\n");
    return stream;
  }

  beforeEach(() => {
    t = createTestDatabase();
    now = Date.UTC(2026, 10, 9, 9, 0, 0);
    bus = new EventBus();
    streams = [];
  });
  afterEach(async () => {
    for (const stream of streams) await stream.cancel().catch(() => {});
    t.dispose();
  });

  it("rejects a request without a session", async () => {
    await setup();
    const res = await ta.app.request("/api/events");
    expect(res.status).toBe(401);
    expect(bus.listenerCount()).toBe(0);
  });

  it("opens an event stream with the headers a proxy needs and sends ready first", async () => {
    await setup({ heartbeatMs: 60_000 });
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const stream = collect(res);
    streams.push(stream);
    await stream.until("event: ready\ndata: {}\n\n");
    expect(stream.text.startsWith("event: ready")).toBe(true);
  });

  it("forwards published events as named SSE events", async () => {
    await setup({ heartbeatMs: 60_000 });
    const stream = await connect();
    bus.publish(progress(40));
    bus.publish({ type: "settings.updated" });
    await stream.until("event: settings.updated\n");
    expect(stream.text).toContain(
      'event: sync.progress\ndata: {"type":"sync.progress","accountId":1,"fetched":40}\n\n',
    );
    expect(stream.text).toContain('event: settings.updated\ndata: {"type":"settings.updated"}\n\n');
  });

  it("sends a ping comment every heartbeat", async () => {
    await setup({ heartbeatMs: 20 });
    const stream = await connect();
    await stream.until(": ping\n\n: ping\n\n");
  });

  it("closes the stream at the next heartbeat once the session is revoked", async () => {
    await setup({ heartbeatMs: 20 });
    const stream = await connect();
    expect(bus.listenerCount()).toBe(1);
    ta.sessions.revoke(ta.cookie.slice("bursar_session=".length));
    await expect(stream.ended()).resolves.toBe(true);
    expect(bus.listenerCount()).toBe(0);
  });

  it("closes the stream when the session has expired", async () => {
    await setup({ heartbeatMs: 20 });
    const stream = await connect();
    now += SESSION_IDLE_MS + 1;
    await expect(stream.ended()).resolves.toBe(true);
    expect(bus.listenerCount()).toBe(0);
  });

  it("does not extend the session while pinging", async () => {
    await setup({ heartbeatMs: 20 });
    const stream = await connect();
    now += SESSION_IDLE_MS - 1_000;
    await stream.until(": ping\n\n: ping\n\n");
    now += 2_000;
    await expect(stream.ended()).resolves.toBe(true);
  });

  it("closes the oldest stream when more than maxStreams are open", async () => {
    await setup({ heartbeatMs: 60_000, maxStreams: 2 });
    const first = await connect();
    const second = await connect();
    expect(bus.listenerCount()).toBe(2);
    const third = await connect();
    await expect(first.ended()).resolves.toBe(true);
    expect(bus.listenerCount()).toBe(2);
    bus.publish(progress(1));
    await second.until("event: sync.progress");
    await third.until("event: sync.progress");
  });

  it("unsubscribes when the client cancels the stream", async () => {
    await setup({ heartbeatMs: 60_000 });
    const stream = await connect();
    expect(bus.listenerCount()).toBe(1);
    await stream.cancel();
    expect(bus.listenerCount()).toBe(0);
  });

  it("unsubscribes when the request is aborted", async () => {
    await setup({ heartbeatMs: 60_000 });
    const controller = new AbortController();
    const stream = collect(await open({ signal: controller.signal }));
    streams.push(stream);
    await stream.until("event: ready");
    expect(bus.listenerCount()).toBe(1);
    controller.abort();
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(0));
  });

  it("closes every stream on shutdown and refuses new ones", async () => {
    const shutdown = new AbortController();
    await setup({ heartbeatMs: 60_000, signal: shutdown.signal });
    const first = await connect();
    const second = await connect();
    shutdown.abort();
    await expect(first.ended()).resolves.toBe(true);
    await expect(second.ended()).resolves.toBe(true);
    expect(bus.listenerCount()).toBe(0);
    expect((await open()).status).toBe(503);
  });

  it("keeps serving other streams when one listener write fails", async () => {
    await setup({ heartbeatMs: 60_000 });
    const first = await connect();
    const second = await connect();
    await first.cancel();
    bus.publish(progress(2));
    await second.until("event: sync.progress");
    expect(bus.listenerCount()).toBe(1);
  });
});
