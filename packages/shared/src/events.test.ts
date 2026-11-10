import { describe, expect, it } from "vitest";
import { SERVER_EVENT_TYPES, type ServerEvent, serverEventSchema } from "./events";

const samples: ServerEvent[] = [
  { type: "sync.started", accountId: 1, connectionId: 2, trigger: "manual" },
  { type: "sync.progress", accountId: 1, fetched: 40 },
  {
    type: "sync.finished",
    accountId: 1,
    connectionId: 2,
    trigger: "background",
    status: "skipped",
    inserted: 0,
    updated: 0,
    removed: 0,
    errorCode: null,
    skipReason: "rate_limited",
    retryAt: 1_700_000_000_000,
  },
  { type: "connection.updated", connectionId: 2, status: "expiring" },
  { type: "notification.created", id: 5, event: "consent_expiring" },
  { type: "backup.finished", status: "failed" },
  { type: "settings.updated" },
];

describe("serverEventSchema", () => {
  it.each(samples.map((sample) => [sample.type, sample] as const))(
    "accepts %s",
    (_type, sample) => {
      expect(serverEventSchema.parse(sample)).toEqual(sample);
    },
  );

  it("lists exactly the literals of the union", () => {
    const literals = serverEventSchema.options.map((option) => option.shape.type.value);
    expect([...SERVER_EVENT_TYPES].sort()).toEqual([...literals].sort());
    expect(new Set(SERVER_EVENT_TYPES).size).toBe(SERVER_EVENT_TYPES.length);
    expect(samples.map((sample) => sample.type).sort()).toEqual([...SERVER_EVENT_TYPES].sort());
  });

  it("rejects an unknown type, a bad enum value and a missing field", () => {
    expect(serverEventSchema.safeParse({ type: "sync.exploded" }).success).toBe(false);
    expect(
      serverEventSchema.safeParse({
        type: "sync.started",
        accountId: 1,
        connectionId: 2,
        trigger: "whenever",
      }).success,
    ).toBe(false);
    expect(serverEventSchema.safeParse({ type: "sync.progress", accountId: 1 }).success).toBe(
      false,
    );
    expect(
      serverEventSchema.safeParse({ type: "sync.progress", accountId: 0, fetched: 1 }).success,
    ).toBe(false);
  });
});
