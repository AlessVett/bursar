import { z } from "zod";
import { backupRunStatusSchema } from "./finance";

/** What started a backup run: the nightly task, the panel button, or `bursar backup run`. */
export const backupTriggerSchema = z.enum(["scheduled", "manual", "cli"]);
export type BackupTrigger = z.infer<typeof backupTriggerSchema>;

/** Where backup sets go: the local directory only, or the local directory plus S3. */
export const backupTargetSchema = z.enum(["local", "s3"]);
export type BackupTarget = z.infer<typeof backupTargetSchema>;

export const backupRunItemSchema = z.object({
  id: z.number().int().positive(),
  trigger: backupTriggerSchema,
  status: backupRunStatusSchema,
  target: backupTargetSchema,
  /** `YYYYMMDDTHHMMSSZ`; null while running or when the run failed before the copy existed. */
  setId: z.string().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  errorMessage: z.string().nullable(),
});
export type BackupRunItem = z.infer<typeof backupRunItemSchema>;

export const backupStatusResponseSchema = z.object({
  target: backupTargetSchema,
  lastSuccessAt: z.number().int().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  runs: z.array(backupRunItemSchema),
});
export type BackupStatusResponse = z.infer<typeof backupStatusResponseSchema>;

/** `POST /api/backups/run` answers 202 with this body. */
export const backupRunResponseSchema = z.object({ queued: z.literal(true) });
export type BackupRunResponse = z.infer<typeof backupRunResponseSchema>;
