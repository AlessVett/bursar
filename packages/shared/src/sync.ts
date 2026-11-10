import { z } from "zod";

/** 202 answer of `POST /api/accounts/:id/sync` and `POST /api/connections/:id/sync`. */
export const syncQueuedResponseSchema = z.object({ queued: z.number().int().positive() });
export type SyncQueuedResponse = z.infer<typeof syncQueuedResponseSchema>;

/** `code` values of the 409 answers of the manual sync routes (translated by the panel). */
export const syncConflictCodeSchema = z.enum([
  "sync_in_progress",
  "account_inactive",
  "connection_inactive",
  "rate_limited",
  "nothing_to_sync",
]);
export type SyncConflictCode = z.infer<typeof syncConflictCodeSchema>;
