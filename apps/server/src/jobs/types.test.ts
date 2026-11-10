import { describe, expect, it } from "vitest";
import type { JobRecord } from "./queue";
import {
  BACKUP_DEDUPE_KEY,
  BACKUP_JOB,
  backupPayloadSchema,
  DELETE_SESSION_JOB,
  deleteSessionPayloadSchema,
  EMAIL_JOB,
  emailDedupeKey,
  emailPayloadSchema,
  parsePayload,
  SYNC_ACCOUNT_JOB,
  syncAccountPayloadSchema,
  syncDedupeKey,
} from "./types";
import { PermanentJobError } from "./worker";

const job = (type: string, payload: unknown): JobRecord => ({
  id: 7,
  type,
  payload,
  attempts: 1,
  maxAttempts: 3,
});

describe("job constants and dedupe keys", () => {
  it("keeps the documented names", () => {
    expect([SYNC_ACCOUNT_JOB, EMAIL_JOB, BACKUP_JOB, DELETE_SESSION_JOB]).toEqual([
      "bank.sync-account",
      "notify.email",
      "backup.run",
      "bank.delete-session",
    ]);
    expect(BACKUP_DEDUPE_KEY).toBe("backup");
    expect(syncDedupeKey(12)).toBe("sync:12");
    expect(emailDedupeKey(3)).toBe("email:3");
  });
});

describe("payload schemas", () => {
  it("accepts a sync payload with and without PSU headers", () => {
    expect(syncAccountPayloadSchema.parse({ accountId: 1, trigger: "manual" })).toEqual({
      accountId: 1,
      trigger: "manual",
    });
    const psu = { ipAddress: "203.0.113.7", userAgent: "ua", acceptLanguage: "it" };
    expect(syncAccountPayloadSchema.parse({ accountId: 1, trigger: "manual", psu }).psu).toEqual(
      psu,
    );
  });

  it.each([
    [{ accountId: 0, trigger: "manual" }],
    [{ accountId: 1.5, trigger: "manual" }],
    [{ accountId: "1", trigger: "manual" }],
    [{ accountId: 1, trigger: "whenever" }],
    [{ accountId: 1, trigger: "manual", psu: { ipAddress: "203.0.113.7" } }],
    [null],
  ])("rejects the invalid sync payload %j", (payload) => {
    expect(syncAccountPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("validates the e-mail, backup and delete-session payloads", () => {
    expect(emailPayloadSchema.safeParse({ notificationId: 4 }).success).toBe(true);
    expect(emailPayloadSchema.safeParse({ notificationId: -4 }).success).toBe(false);
    expect(backupPayloadSchema.safeParse({ trigger: "scheduled" }).success).toBe(true);
    expect(backupPayloadSchema.safeParse({ trigger: "cli" }).success).toBe(false);
    expect(deleteSessionPayloadSchema.safeParse({ providerSessionId: "abc" }).success).toBe(true);
    expect(deleteSessionPayloadSchema.safeParse({ providerSessionId: "" }).success).toBe(false);
  });
});

describe("parsePayload", () => {
  it("returns the typed payload", () => {
    const parsed = parsePayload(
      syncAccountPayloadSchema,
      job(SYNC_ACCOUNT_JOB, { accountId: 5, trigger: "background" }),
    );
    expect(parsed).toEqual({ accountId: 5, trigger: "background" });
  });

  it("throws a PermanentJobError naming the field but never echoing the value", () => {
    const marker = "sess-0123456789-marker";
    let caught: unknown;
    try {
      parsePayload(
        deleteSessionPayloadSchema,
        job(DELETE_SESSION_JOB, { providerSessionId: 42, marker }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermanentJobError);
    const message = (caught as Error).message;
    expect(message).toContain('"bank.delete-session"');
    expect(message).toContain("#7");
    expect(message).toContain("providerSessionId");
    expect(message).not.toContain(marker);
  });

  it("describes a non-object payload as the root", () => {
    expect(() => parsePayload(emailPayloadSchema, job(EMAIL_JOB, null))).toThrow(/\(root\)/);
  });
});
