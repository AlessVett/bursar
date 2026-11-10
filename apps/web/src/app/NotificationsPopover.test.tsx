import type { NotificationEvent, NotificationItem } from "@bursar/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { renderRoutes, stubApi } from "../test/router";
import {
  NotificationsPopover,
  type PopoverNotification,
  toPopoverNotification,
  useNotificationsFeed,
} from "./NotificationsPopover";

const NOW = Date.now();
const HOUR_MS = 3_600_000;

function item(overrides: Partial<NotificationItem> & Pick<NotificationItem, "id" | "event">) {
  return {
    params: {},
    link: null,
    createdAt: NOW - HOUR_MS,
    readAt: null,
    ...overrides,
  } satisfies NotificationItem;
}

describe("toPopoverNotification", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("maps every event to a title, a body, a tone and the link", () => {
    const t = i18n.t;
    const expiring = toPopoverNotification(
      item({
        id: 1,
        event: "consent_expiring",
        params: { bankName: "Northwind Bank", days: 9 },
        link: "/accounts",
      }),
      t,
    );
    expect(expiring).toMatchObject({
      id: 1,
      title: "Consent expiring",
      tone: "warning",
      to: "/accounts",
      read: false,
      at: NOW - HOUR_MS,
    });
    expect(expiring.body).toBe(
      "Consent for Northwind Bank has 9 days left. Renew it to keep your data up to date.",
    );

    const oneDay = toPopoverNotification(
      item({ id: 2, event: "consent_expiring", params: { bankName: "Northwind Bank", days: 1 } }),
      t,
    );
    expect(oneDay.body).toContain("has 1 day left");

    const expired = toPopoverNotification(
      item({ id: 3, event: "consent_expired", params: { bankName: "Banca Esempio" } }),
      t,
    );
    expect(expired).toMatchObject({ title: "Consent expired", tone: "danger" });
    expect(expired.body).toBe("Consent for Banca Esempio has expired. Renew it to resume syncing.");

    const problem = toPopoverNotification(
      item({ id: 4, event: "connection_error", params: { bankName: "Banca Esempio" } }),
      t,
    );
    expect(problem).toMatchObject({ title: "Bank connection problem", tone: "danger" });

    const failing = toPopoverNotification(
      item({
        id: 5,
        event: "sync_failing",
        params: { accountName: "Everyday Account", bankName: "Northwind Bank" },
        link: "/accounts/3",
        readAt: NOW,
      }),
      t,
    );
    expect(failing).toMatchObject({
      title: "Sync is failing",
      tone: "warning",
      to: "/accounts/3",
      read: true,
    });
    expect(failing.body).toBe("Everyday Account has not synced for over two days.");

    const backup = toPopoverNotification(
      item({ id: 6, event: "backup_failing", link: "/settings#backups" }),
      t,
    );
    expect(backup).toMatchObject({
      title: "Backups are failing",
      tone: "warning",
      to: "/settings#backups",
    });
  });

  it("speaks Italian with the server's parameter names and never leaves a placeholder", async () => {
    await i18n.changeLanguage("it");
    const seeded = toPopoverNotification(
      item({ id: 1, event: "consent_expiring", params: { bankName: "Northwind Bank", days: 9 } }),
      i18n.t,
    );
    expect(seeded.title).toBe("Consenso in scadenza");
    expect(seeded.body).toContain("Northwind Bank");
    expect(seeded.body).toContain("9 giorni");
    const account = toPopoverNotification(
      item({ id: 2, event: "sync_failing", params: { accountName: "Conto Smart" } }),
      i18n.t,
    );
    expect(account.body).toContain("Conto Smart");
    for (const text of [seeded.title, seeded.body, account.title, account.body]) {
      expect(text).not.toContain("{{");
      expect(text).not.toContain("undefined");
    }
  });

  it("drops links that are not panel paths and falls back for unknown events", () => {
    const external = toPopoverNotification(
      item({ id: 1, event: "backup_failing", link: "https://example.test/phish" }),
      i18n.t,
    );
    expect(external.to).toBeNull();
    const protocolRelative = toPopoverNotification(
      item({ id: 2, event: "backup_failing", link: "//example.test" }),
      i18n.t,
    );
    expect(protocolRelative.to).toBeNull();
    const unknown = toPopoverNotification(
      item({ id: 3, event: "future_event" as NotificationEvent }),
      i18n.t,
    );
    expect(unknown).toMatchObject({ title: "Bursar notification", tone: "info" });
    expect(unknown.body).not.toContain("notifications.events");
  });
});

describe("NotificationsPopover", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  const ITEMS: PopoverNotification[] = [
    {
      id: 1,
      title: "Consent expiring",
      body: "Consent for Northwind Bank has 9 days left.",
      at: NOW - HOUR_MS,
      read: false,
      tone: "warning",
      to: "/accounts",
    },
    {
      id: 2,
      title: "Sync is failing",
      body: "Everyday Account has not synced for over two days.",
      at: NOW - 5 * HOUR_MS,
      read: true,
      tone: "warning",
      to: "/accounts/3",
    },
  ];

  it("lists the items with the new-count chip, an unread dot and no see-all footer", () => {
    const onOpenItem = vi.fn();
    const onMarkAllRead = vi.fn();
    render(
      <NotificationsPopover
        items={ITEMS}
        unread={1}
        onOpenItem={onOpenItem}
        onMarkAllRead={onMarkAllRead}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notifications: 1 unread" }));
    const dialog = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(dialog).getByText("1 new")).not.toBeNull();
    expect(within(dialog).getAllByText("Unread")).toHaveLength(1);
    expect(within(dialog).queryByText(/see all/i)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /Consent expiring/ }));
    expect(onOpenItem).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "Notifications: 1 unread" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(onMarkAllRead).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state and disables Mark all as read at zero", () => {
    render(
      <NotificationsPopover
        items={[]}
        unread={0}
        onOpenItem={() => undefined}
        onMarkAllRead={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("No notifications")).not.toBeNull();
    const markAll = screen.getByRole("button", { name: "Mark all as read" }) as HTMLButtonElement;
    expect(markAll.disabled).toBe(true);
    expect(screen.queryByText(/see all/i)).toBeNull();
  });
});

function Page() {
  const feed = useNotificationsFeed();
  const location = useLocation();
  return (
    <>
      <NotificationsPopover {...feed} />
      <p data-testid="where">{`${location.pathname}${location.hash}`}</p>
    </>
  );
}

describe("useNotificationsFeed", () => {
  let state: { items: NotificationItem[]; unread: number };
  const posts: string[] = [];

  function mount() {
    stubApi({
      "GET /api/notifications?limit=6": () => ({ status: 200, body: state }),
      "POST /api/notifications/1/read": () => {
        posts.push("read:1");
        state = {
          items: state.items.map((entry) =>
            entry.id === 1 ? { ...entry, readAt: Date.now() } : entry,
          ),
          unread: 0,
        };
        return { status: 204 };
      },
      "POST /api/notifications/read-all": () => {
        posts.push("read-all");
        state = {
          items: state.items.map((entry) => ({ ...entry, readAt: entry.readAt ?? Date.now() })),
          unread: 0,
        };
        return { status: 200, body: { updated: 1 } };
      },
    });
    return renderRoutes([
      { path: "/", element: <Page /> },
      { path: "/accounts", element: <Page /> },
      { path: "/settings", element: <Page /> },
    ]);
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    posts.length = 0;
    state = {
      items: [
        item({
          id: 1,
          event: "backup_failing",
          link: "/settings#backups",
          createdAt: NOW - HOUR_MS,
        }),
        item({
          id: 2,
          event: "consent_expiring",
          params: { bankName: "Northwind Bank", days: 9 },
          link: "/accounts",
          createdAt: NOW - 5 * HOUR_MS,
          readAt: NOW - 4 * HOUR_MS,
        }),
      ],
      unread: 1,
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the feed, marks an unread item read and follows its link", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Notifications: 1 unread" }));
    fireEvent.click(await screen.findByRole("button", { name: /Backups are failing/ }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/settings#backups"));
    await waitFor(() => expect(posts).toEqual(["read:1"]));
    expect(await screen.findByRole("button", { name: "Notifications" })).not.toBeNull();
  });

  it("does not mark an item that is already read, but still navigates", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Notifications: 1 unread" }));
    fireEvent.click(await screen.findByRole("button", { name: /Consent expiring/ }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/accounts"));
    expect(posts).toEqual([]);
  });

  it("marks everything read and disables the button afterwards", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Notifications: 1 unread" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(posts).toEqual(["read-all"]));
    await waitFor(() => {
      const markAll = screen.getByRole("button", { name: "Mark all as read" }) as HTMLButtonElement;
      expect(markAll.disabled).toBe(true);
    });
  });
});
