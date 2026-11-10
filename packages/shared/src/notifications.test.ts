import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_MAX_LIMIT,
  notificationItemSchema,
  notificationListQuerySchema,
  notificationListResponseSchema,
  testEmailResponseSchema,
} from "./notifications";

describe("notificationListQuerySchema", () => {
  it("accepts a missing limit and numeric limits from 1 to the maximum", () => {
    expect(notificationListQuerySchema.parse({})).toEqual({});
    expect(notificationListQuerySchema.parse({ limit: "1" })).toEqual({ limit: 1 });
    expect(notificationListQuerySchema.parse({ limit: String(NOTIFICATION_MAX_LIMIT) })).toEqual({
      limit: NOTIFICATION_MAX_LIMIT,
    });
  });

  it.each(["0", "51", "-1", "2.5", "abc", "", "1e1", "1000"])("rejects %j", (limit) => {
    expect(notificationListQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});

describe("notification payload schemas", () => {
  const item = {
    id: 3,
    event: "consent_expiring",
    params: { bankName: "Banca Esempio", days: 3 },
    link: "/accounts",
    createdAt: 1_700_000_000_000,
    readAt: null,
  };

  it("accepts an item and a list response", () => {
    expect(notificationItemSchema.parse(item)).toEqual(item);
    expect(notificationListResponseSchema.parse({ items: [item], unread: 1 }).unread).toBe(1);
  });

  it("rejects an unknown event and nested params", () => {
    expect(notificationItemSchema.safeParse({ ...item, event: "report_ready" }).success).toBe(
      false,
    );
    expect(notificationItemSchema.safeParse({ ...item, params: { a: { b: 1 } } }).success).toBe(
      false,
    );
  });

  it.each([
    "https://evil.example.test/",
    "//evil.example.test",
    "/\t/evil.example.test",
    "/a\nb",
    "/\\evil",
    "accounts",
  ])("rejects the link %j", (link) => {
    expect(notificationItemSchema.safeParse({ ...item, link }).success).toBe(false);
  });

  it("accepts a null link", () => {
    expect(notificationItemSchema.safeParse({ ...item, link: null }).success).toBe(true);
  });

  it("only accepts sent: true as a test email response", () => {
    expect(testEmailResponseSchema.safeParse({ sent: true }).success).toBe(true);
    expect(testEmailResponseSchema.safeParse({ sent: false }).success).toBe(false);
  });
});
