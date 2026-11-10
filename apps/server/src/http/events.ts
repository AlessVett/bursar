import type { ServerEvent } from "@bursar/shared";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../auth/routes";
import type { SessionStore } from "../auth/sessions";
import type { EventBus } from "../events/bus";
import type { AppEnv } from "./app";

export const EVENTS_HEARTBEAT_MS = 25_000;
export const EVENTS_MAX_STREAMS = 10;

export interface EventsRouteDeps {
  bus: EventBus;
  sessions: SessionStore;
  heartbeatMs?: number;
  maxStreams?: number;
  /** Aborting it closes every open stream, so a graceful shutdown does not wait for the panel. */
  signal?: AbortSignal;
}

interface OpenStream {
  close(): void;
}

/**
 * GET / (mounted at /api/events behind `requireSession`): a server-sent events stream of bus
 * events. `: ping` comments keep proxies from idling the connection out, and every ping first
 * checks that the session still exists (without extending it) so a logout ends the stream.
 */
export function eventsRoute(deps: EventsRouteDeps): Hono<AppEnv> {
  const heartbeatMs = deps.heartbeatMs ?? EVENTS_HEARTBEAT_MS;
  const maxStreams = deps.maxStreams ?? EVENTS_MAX_STREAMS;
  const encoder = new TextEncoder();
  // A Set iterates in insertion order, so the first member is the oldest stream.
  const open = new Set<OpenStream>();
  const routes = new Hono<AppEnv>();

  routes.get("/", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: "Unauthorized" }, 401);
    if (deps.signal?.aborted) return c.json({ error: "Shutting down" }, 503);
    const requestSignal = c.req.raw.signal;

    let teardown = (): void => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const handle: OpenStream = { close };
        const timer = setInterval(() => {
          if (deps.sessions.peek(token) === null) close();
          else send(": ping\n\n");
        }, heartbeatMs);
        const unsubscribe = deps.bus.subscribe((event: ServerEvent) =>
          send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        );

        function send(chunk: string): void {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // The consumer went away without telling us.
            close();
          }
        }

        function close(): void {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          unsubscribe();
          open.delete(handle);
          requestSignal.removeEventListener("abort", close);
          deps.signal?.removeEventListener("abort", close);
          try {
            controller.close();
          } catch {
            // Already closed or cancelled.
          }
        }

        teardown = close;
        while (open.size >= maxStreams) {
          const oldest = open.values().next();
          if (oldest.done) break;
          oldest.value.close();
        }
        open.add(handle);
        requestSignal.addEventListener("abort", close);
        deps.signal?.addEventListener("abort", close);
        send("event: ready\ndata: {}\n\n");
      },
      cancel() {
        teardown();
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return routes;
}
