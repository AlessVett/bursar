import { describe, expect, it } from "vitest";
import {
  backupRunItemSchema,
  backupRunResponseSchema,
  backupStatusResponseSchema,
  backupTriggerSchema,
} from "./backups";

const run = {
  id: 3,
  trigger: "scheduled",
  status: "succeeded",
  target: "s3",
  setId: "20261109T020000Z",
  startedAt: 1_794_189_600_000,
  finishedAt: 1_794_189_604_000,
  sizeBytes: 1_048_576,
  errorMessage: null,
};

describe("backup DTOs", () => {
  it("accepts a finished run, a running run and a status response", () => {
    expect(backupRunItemSchema.parse(run)).toEqual(run);
    const running = { ...run, status: "running", setId: null, finishedAt: null, sizeBytes: null };
    expect(backupRunItemSchema.safeParse(running).success).toBe(true);
    const status = { target: "local", lastSuccessAt: null, consecutiveFailures: 2, runs: [run] };
    expect(backupStatusResponseSchema.parse(status)).toEqual(status);
  });

  it("rejects unknown triggers, statuses and targets", () => {
    expect(backupTriggerSchema.safeParse("cron").success).toBe(false);
    expect(backupRunItemSchema.safeParse({ ...run, status: "partial" }).success).toBe(false);
    expect(backupRunItemSchema.safeParse({ ...run, target: "ftp" }).success).toBe(false);
    expect(backupRunItemSchema.safeParse({ ...run, sizeBytes: -1 }).success).toBe(false);
  });

  it("describes the 202 body of a manual run", () => {
    expect(backupRunResponseSchema.parse({ queued: true })).toEqual({ queued: true });
    expect(backupRunResponseSchema.safeParse({ queued: false }).success).toBe(false);
  });
});
