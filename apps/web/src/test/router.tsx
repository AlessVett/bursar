import type { AuthStatus } from "@bursar/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createMemoryRouter, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { vi } from "vitest";
import { queryKeys } from "../lib/query-keys";

/** A query client like the app's (no retries) with an optional auth status already cached. */
export function testQueryClient(authStatus?: AuthStatus): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (authStatus) client.setQueryData(queryKeys.authStatus, authStatus);
  return client;
}

/** Renders a memory router over `routes` and returns it with the query client. */
export function renderRoutes(
  routes: RouteObject[],
  options: { initialEntries?: string[]; initialIndex?: number; client?: QueryClient } = {},
) {
  const client = options.client ?? testQueryClient();
  const router = createMemoryRouter(routes, {
    initialEntries: options.initialEntries ?? ["/"],
    initialIndex: options.initialIndex,
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, client, ...view };
}

/** Stubs `fetch` with a handler per "METHOD path"; unknown requests answer 404 JSON. */
export function stubApi(
  handlers: Record<string, (body: unknown) => { status: number; body?: unknown }>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = handlers[key];
    const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const result = handler ? handler(parsed) : { status: 404, body: { error: "Not found" } };
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
