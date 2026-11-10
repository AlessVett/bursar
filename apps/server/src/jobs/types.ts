import { syncTriggerSchema } from "@bursar/shared";
import { z } from "zod";
import type { JobRecord } from "./queue";
import { PermanentJobError } from "./worker";

/** Synchronises one bank account (Task 13). */
export const SYNC_ACCOUNT_JOB = "bank.sync-account";
export const syncAccountPayloadSchema = z.object({
  accountId: z.number().int().positive(),
  trigger: syncTriggerSchema,
  psu: z
    .object({
      ipAddress: z.string(),
      userAgent: z.string(),
      accept: z.string().optional(),
      acceptLanguage: z.string().optional(),
    })
    .optional(),
});
export type SyncAccountPayload = z.infer<typeof syncAccountPayloadSchema>;
export const syncDedupeKey = (accountId: number): string => `sync:${accountId}`;

/** Sends the e-mail of one stored notification (Task 9). */
export const EMAIL_JOB = "notify.email";
export const emailPayloadSchema = z.object({ notificationId: z.number().int().positive() });
export type EmailPayload = z.infer<typeof emailPayloadSchema>;
export const emailDedupeKey = (notificationId: number): string => `email:${notificationId}`;

/** Creates an encrypted backup set (Task 15). */
export const BACKUP_JOB = "backup.run";
export const backupPayloadSchema = z.object({ trigger: z.enum(["scheduled", "manual"]) });
export type BackupPayload = z.infer<typeof backupPayloadSchema>;
export const BACKUP_DEDUPE_KEY = "backup";

/** Deletes an Enable Banking session at the provider after a local disconnect (Task 14). */
export const DELETE_SESSION_JOB = "bank.delete-session";
export const deleteSessionPayloadSchema = z.object({ providerSessionId: z.string().min(1) });
export type DeleteSessionPayload = z.infer<typeof deleteSessionPayloadSchema>;

/**
 * Validates a claimed job's payload. An invalid payload never becomes valid by retrying, so it
 * throws {@link PermanentJobError}. The message lists field paths and rules only, never values:
 * payloads can carry provider session ids and client addresses.
 */
export function parsePayload<T>(schema: z.ZodType<T>, job: JobRecord): T {
  const result = schema.safeParse(job.payload);
  if (result.success) return result.data;
  const problems = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new PermanentJobError(`Invalid payload for job "${job.type}" (#${job.id}): ${problems}`);
}
