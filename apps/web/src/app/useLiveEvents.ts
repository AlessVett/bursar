import {
  type AccountDetailResponse,
  type ConnectionsResponse,
  type HomeSummary,
  SERVER_EVENT_TYPES,
  type ServerEvent,
  serverEventSchema,
} from "@bursar/shared";
import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { feedback } from "../components/feedback";
import { useFormatters } from "../lib/format";
import { queryKeys } from "../lib/query-keys";
import { announceBackupFinished } from "./backup-toast";

export const EVENTS_URL = "/api/events";
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

type SyncFinishedEvent = Extract<ServerEvent, { type: "sync.finished" }>;

export interface LiveContext {
  queryClient: QueryClient;
  t: TFunction;
  /** Absolute date and time in the server time zone. */
  formatTime(at: number): string;
}

/** 1 s, 2 s, 4 s … capped at 30 s; `failures` counts consecutive stream errors (≥ 1). */
export function reconnectDelay(failures: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, failures - 1));
}

/** Everything that may have changed while the stream was down. */
const RESYNC_KEYS: readonly QueryKey[] = [
  queryKeys.connections,
  queryKeys.summary,
  ["accounts"],
  ["transactions"],
  ["cashflow"],
  queryKeys.notifications,
  queryKeys.backups,
];

function invalidate(queryClient: QueryClient, keys: readonly QueryKey[]): void {
  for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
}

/** The account name as the panel last saw it; events carry ids only. */
export function accountNameFromCache(queryClient: QueryClient, accountId: number): string | null {
  const connections = queryClient.getQueryData<ConnectionsResponse>(queryKeys.connections);
  for (const connection of connections?.connections ?? []) {
    const match = connection.accounts.find((account) => account.id === accountId);
    if (match) return match.name;
  }
  const detail = queryClient.getQueryData<AccountDetailResponse>(queryKeys.account(accountId));
  if (detail) return detail.account.name;
  const summary = queryClient.getQueryData<HomeSummary>(queryKeys.summary);
  return summary?.accounts.find((account) => account.id === accountId)?.name ?? null;
}

/** Translated text for an Enable Banking error code or a Bursar skip/error code. */
export function syncErrorText(t: TFunction, code: string | null): string {
  const generic = t("syncErrors.generic");
  if (!code || !/^[A-Za-z_]+$/.test(code)) return generic;
  return t(`syncErrors.${code}`, { defaultValue: generic });
}

function withSyncing<T extends { id: number; syncInProgress: boolean }>(
  accounts: T[],
  accountId: number,
): T[] {
  return accounts.map((account) =>
    account.id === accountId ? { ...account, syncInProgress: true } : account,
  );
}

function markSyncing(queryClient: QueryClient, accountId: number): void {
  queryClient.setQueryData<ConnectionsResponse>(queryKeys.connections, (old) =>
    old
      ? {
          ...old,
          connections: old.connections.map((connection) => ({
            ...connection,
            accounts: withSyncing(connection.accounts, accountId),
          })),
        }
      : old,
  );
  queryClient.setQueryData<HomeSummary>(queryKeys.summary, (old) =>
    old ? { ...old, accounts: withSyncing(old.accounts, accountId) } : old,
  );
}

function notifySyncFinished(event: SyncFinishedEvent, ctx: LiveContext): void {
  const { t } = ctx;
  const account =
    accountNameFromCache(ctx.queryClient, event.accountId) ?? t("live.unknownAccount");
  if (event.status === "succeeded") {
    // The 06:00 daily sync would otherwise toast once per account.
    if (event.trigger === "background") return;
    feedback(
      t("live.syncCompleted"),
      event.inserted > 0
        ? t("live.syncCompletedDetail", { account, count: event.inserted })
        : t("live.syncNoNew", { account }),
      "success",
    );
    return;
  }
  if (event.status === "skipped") {
    if (event.skipReason === "rate_limited") {
      feedback(
        t("live.rateLimited"),
        event.retryAt === null
          ? t("live.rateLimitedNoTime", { account })
          : t("live.rateLimitedDetail", { account, time: ctx.formatTime(event.retryAt) }),
        "warning",
      );
      return;
    }
    if (event.skipReason === "daily_cap") {
      feedback(t("live.dailyCap"), t("live.dailyCapDetail", { account }), "warning");
      return;
    }
    feedback(
      t("live.syncSkipped"),
      t("live.syncSkippedDetail", { account, reason: syncErrorText(t, event.skipReason) }),
      "warning",
    );
    return;
  }
  feedback(
    t("live.syncFailed"),
    t("live.syncFailedDetail", { account, reason: syncErrorText(t, event.errorCode) }),
    "error",
  );
}

/** The invalidation map of the live panel (one place, tested event by event). */
export function applyServerEvent(event: ServerEvent, ctx: LiveContext): void {
  const { queryClient } = ctx;
  switch (event.type) {
    case "sync.started":
      markSyncing(queryClient, event.accountId);
      invalidate(queryClient, [queryKeys.account(event.accountId)]);
      return;
    case "sync.progress":
      return;
    case "sync.finished": {
      invalidate(queryClient, [
        queryKeys.connections,
        queryKeys.account(event.accountId),
        queryKeys.summary,
        ["transactions"],
        ["cashflow"],
        queryKeys.notifications,
      ]);
      notifySyncFinished(event, ctx);
      return;
    }
    case "connection.updated":
      invalidate(queryClient, [queryKeys.connections, queryKeys.summary, ["accounts"]]);
      return;
    case "notification.created":
      invalidate(queryClient, [queryKeys.notifications, queryKeys.summary]);
      return;
    case "backup.finished":
      invalidate(queryClient, [queryKeys.backups, queryKeys.summary]);
      announceBackupFinished(event.status);
      return;
    case "settings.updated":
      invalidate(queryClient, [queryKeys.settings]);
      return;
  }
}

/**
 * Keeps the panel in step with the server over GET /api/events (server-sent events).
 * Mount once, inside FormatProvider (AppShell renders <LiveEvents />).
 */
export function useLiveEvents(): void {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { absolute } = useFormatters();
  const latest = useRef({ t, absolute });

  useEffect(() => {
    latest.current = { t, absolute };
  });

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const ctx: LiveContext = {
      queryClient,
      get t() {
        return latest.current.t;
      },
      formatTime: (at) => latest.current.absolute(at, true),
    };
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let missedEvents = false;
    let stopped = false;

    const onEvent = (message: MessageEvent) => {
      if (typeof message.data !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = serverEventSchema.safeParse(data);
      if (!parsed.success || parsed.data.type !== message.type) return;
      applyServerEvent(parsed.data, ctx);
    };

    const onReady = () => {
      failures = 0;
      if (missedEvents) {
        missedEvents = false;
        invalidate(queryClient, RESYNC_KEYS);
      }
    };

    const connect = () => {
      if (stopped) return;
      const stream = new EventSource(EVENTS_URL);
      source = stream;
      stream.addEventListener("ready", onReady);
      for (const type of SERVER_EVENT_TYPES) stream.addEventListener(type, onEvent);
      stream.onerror = () => {
        stream.close();
        source = null;
        failures += 1;
        missedEvents = true;
        // A stream that fails because the session ended: the auth status query notices
        // and RequireAuth sends the owner to the login page.
        void queryClient.invalidateQueries({ queryKey: queryKeys.authStatus });
        timer = setTimeout(connect, reconnectDelay(failures));
      };
    };

    connect();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      source?.close();
    };
  }, [queryClient]);
}

/** Mount point for useLiveEvents inside the shell's providers. */
export function LiveEvents(): null {
  useLiveEvents();
  return null;
}
