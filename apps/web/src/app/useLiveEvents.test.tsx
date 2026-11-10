import type { AccountSummary, ConnectionsResponse } from "@bursar/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { feedback } from "../components/feedback";
import i18n from "../i18n";
import { FormatProvider } from "../lib/format";
import { queryKeys } from "../lib/query-keys";
import { RECONNECT_MAX_MS, reconnectDelay, useLiveEvents } from "./useLiveEvents";

vi.mock("../components/feedback", () => ({ feedback: vi.fn() }));

type Listener = (event: MessageEvent) => void;

/** Stands in for the browser EventSource; tests push named events with `emit`. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  static latest(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error("No EventSource was opened");
    return source;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(): void {}

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const message = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    for (const listener of this.listeners.get(type) ?? []) listener(message);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

const NOW = Date.UTC(2026, 10, 9, 9, 0);
const DAY = 86_400_000;

function account(id: number, name: string): AccountSummary {
  return {
    id,
    connectionId: 3,
    name,
    nickname: null,
    bankProduct: "Current account",
    maskedIdentifier: "IT60 •••• •••• 1234",
    iban: null,
    last4: "1234",
    currency: "EUR",
    cashAccountType: "CACC",
    status: "active",
    balance: null,
    net30d: { inMinor: 0, outMinor: 0, netMinor: 0 },
    daily30d: [],
    lastSyncedAt: NOW - DAY,
    lastSyncError: null,
    rateLimitedUntil: null,
    syncInProgress: false,
  };
}

const CONNECTIONS: ConnectionsResponse = {
  connections: [
    {
      id: 3,
      bankName: "Northwind Bank",
      country: "IT",
      hasLogo: false,
      status: "active",
      validUntil: NOW + 90 * DAY,
      createdAt: NOW - 30 * DAY,
      renewedAt: null,
      lastError: null,
      accounts: [account(7, "Everyday account"), account(8, "Rainy day savings")],
    },
  ],
  removedAccounts: [],
};

function finished(overrides: Record<string, unknown> = {}) {
  return {
    type: "sync.finished",
    accountId: 7,
    connectionId: 3,
    trigger: "manual",
    status: "succeeded",
    inserted: 3,
    updated: 0,
    removed: 0,
    errorCode: null,
    skipReason: null,
    retryAt: null,
    ...overrides,
  };
}

let queryClient: QueryClient;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <FormatProvider timeZone="Europe/Rome">{children}</FormatProvider>
    </QueryClientProvider>
  );
}

function invalidatedKeys(): unknown[] {
  return invalidate.mock.calls.map(([filters]) => filters?.queryKey);
}

function emit(type: string, data: unknown): void {
  act(() => FakeEventSource.latest().emit(type, data));
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  queryClient = new QueryClient();
  invalidate = vi.spyOn(queryClient, "invalidateQueries");
  vi.mocked(feedback).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useLiveEvents", () => {
  it("opens one stream on /api/events and closes it on unmount", () => {
    const { unmount } = renderHook(() => useLiveEvents(), { wrapper });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest().url).toBe("/api/events");
    unmount();
    expect(FakeEventSource.latest().closed).toBe(true);
  });

  it("marks the account as syncing when a sync starts", () => {
    queryClient.setQueryData(queryKeys.connections, CONNECTIONS);
    renderHook(() => useLiveEvents(), { wrapper });
    emit("sync.started", {
      type: "sync.started",
      accountId: 7,
      connectionId: 3,
      trigger: "manual",
    });

    const data = queryClient.getQueryData<ConnectionsResponse>(queryKeys.connections);
    const accounts = data?.connections[0]?.accounts ?? [];
    expect(accounts.map((a) => a.syncInProgress)).toEqual([true, false]);
    expect(invalidatedKeys()).toEqual([queryKeys.account(7)]);
    expect(feedback).not.toHaveBeenCalled();
  });

  it("refreshes every view of the data and toasts a finished manual sync", () => {
    queryClient.setQueryData(queryKeys.connections, CONNECTIONS);
    renderHook(() => useLiveEvents(), { wrapper });
    emit("sync.started", {
      type: "sync.started",
      accountId: 7,
      connectionId: 3,
      trigger: "manual",
    });
    invalidate.mockClear();
    emit("sync.finished", finished());

    expect(invalidatedKeys()).toEqual([
      queryKeys.connections,
      queryKeys.account(7),
      queryKeys.summary,
      ["transactions"],
      ["cashflow"],
      queryKeys.notifications,
    ]);
    expect(feedback).toHaveBeenCalledWith(
      "Sync completed",
      "Everyday account: 3 new transactions.",
      "success",
    );

    emit("sync.finished", finished({ inserted: 1 }));
    expect(feedback).toHaveBeenLastCalledWith(
      "Sync completed",
      "Everyday account: 1 new transaction.",
      "success",
    );
  });

  it("stays quiet when a background sync succeeds, even without its sync.started", () => {
    queryClient.setQueryData(queryKeys.connections, CONNECTIONS);
    renderHook(() => useLiveEvents(), { wrapper });
    // The panel connected mid-sync: only the finished event arrives, and it carries the trigger.
    emit("sync.finished", finished({ trigger: "background" }));
    expect(invalidatedKeys()).toContainEqual(queryKeys.summary);
    expect(feedback).not.toHaveBeenCalled();
  });

  it("warns with the retry time when the bank rate-limits the account", () => {
    queryClient.setQueryData(queryKeys.connections, CONNECTIONS);
    renderHook(() => useLiveEvents(), { wrapper });
    emit(
      "sync.finished",
      finished({
        status: "skipped",
        inserted: 0,
        skipReason: "rate_limited",
        retryAt: Date.UTC(2026, 10, 9, 18, 30),
      }),
    );
    expect(feedback).toHaveBeenCalledWith(
      "Sync paused by the bank",
      expect.stringContaining("Everyday account: the bank limits how often Bursar can read it."),
      "warning",
    );
    expect(vi.mocked(feedback).mock.calls[0]?.[1]).toContain("19:30");
  });

  it("warns when the daily background cap is used up", () => {
    queryClient.setQueryData(queryKeys.connections, CONNECTIONS);
    renderHook(() => useLiveEvents(), { wrapper });
    emit("sync.finished", finished({ status: "skipped", inserted: 0, skipReason: "daily_cap" }));
    expect(feedback).toHaveBeenCalledWith(
      "Daily sync limit reached",
      "Everyday account: the bank allows only a few background reads a day. The next sync runs tomorrow.",
      "warning",
    );
  });

  it("reports a failed sync with the translated error code", () => {
    queryClient.setQueryData(queryKeys.connections, CONNECTIONS);
    renderHook(() => useLiveEvents(), { wrapper });
    emit(
      "sync.finished",
      finished({ status: "failed", inserted: 0, errorCode: "EXPIRED_SESSION" }),
    );
    expect(feedback).toHaveBeenCalledWith(
      "Sync failed",
      "Everyday account: The bank consent has expired. Renew it to resume syncing.",
      "error",
    );
  });

  it("falls back to a generic reason and a generic account name", () => {
    renderHook(() => useLiveEvents(), { wrapper });
    emit(
      "sync.finished",
      finished({ accountId: 99, status: "failed", inserted: 0, errorCode: "SOMETHING_NEW" }),
    );
    expect(feedback).toHaveBeenCalledWith(
      "Sync failed",
      "Account: The bank did not complete the request. Bursar will try again at the next sync.",
      "error",
    );
  });

  it("invalidates the queries each other event affects", () => {
    renderHook(() => useLiveEvents(), { wrapper });
    emit("connection.updated", { type: "connection.updated", connectionId: 3, status: "expired" });
    expect(invalidatedKeys()).toEqual([queryKeys.connections, queryKeys.summary, ["accounts"]]);

    invalidate.mockClear();
    emit("notification.created", {
      type: "notification.created",
      id: 5,
      event: "consent_expiring",
    });
    expect(invalidatedKeys()).toEqual([queryKeys.notifications, queryKeys.summary]);

    invalidate.mockClear();
    emit("backup.finished", { type: "backup.finished", status: "failed" });
    expect(invalidatedKeys()).toEqual([queryKeys.backups, queryKeys.summary]);
    // A finished backup produces exactly one toast (Task 22): "Backup failed" for a failed run.
    expect(feedback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(feedback).mock.calls[0]?.[0]).toBe("Backup failed");
    vi.mocked(feedback).mockClear();

    invalidate.mockClear();
    emit("settings.updated", { type: "settings.updated" });
    expect(invalidatedKeys()).toEqual([queryKeys.settings]);

    invalidate.mockClear();
    emit("sync.progress", { type: "sync.progress", accountId: 7, fetched: 40 });
    expect(invalidatedKeys()).toEqual([]);
    expect(feedback).not.toHaveBeenCalled();
  });

  it("ignores payloads that are not valid events", () => {
    renderHook(() => useLiveEvents(), { wrapper });
    emit("sync.finished", "{not json");
    emit("sync.finished", { type: "sync.finished", accountId: "seven" });
    emit("settings.updated", { type: "sync.progress", accountId: 7, fetched: 1 });
    expect(invalidatedKeys()).toEqual([]);
    expect(feedback).not.toHaveBeenCalled();
  });

  it("reconnects with a growing delay and resynchronises after a gap", () => {
    vi.useFakeTimers();
    renderHook(() => useLiveEvents(), { wrapper });
    const first = FakeEventSource.latest();

    act(() => first.fail());
    expect(first.closed).toBe(true);
    expect(invalidatedKeys()).toContainEqual(queryKeys.authStatus);
    act(() => vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => FakeEventSource.latest().fail());
    act(() => vi.advanceTimersByTime(1_999));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(3);

    invalidate.mockClear();
    emit("ready", {});
    expect(invalidatedKeys()).toEqual(
      expect.arrayContaining([queryKeys.connections, queryKeys.summary, ["transactions"]]),
    );

    act(() => FakeEventSource.latest().fail());
    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("caps the reconnect delay at 30 seconds", () => {
    expect([1, 2, 3, 6, 10].map(reconnectDelay)).toEqual([1_000, 2_000, 4_000, 30_000, 30_000]);
    expect(RECONNECT_MAX_MS).toBe(30_000);
  });

  it("does nothing where EventSource does not exist", () => {
    vi.stubGlobal("EventSource", undefined);
    const { unmount } = renderHook(() => useLiveEvents(), { wrapper });
    unmount();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
