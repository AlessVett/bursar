import { z } from "zod";

const count = z.number().int().nonnegative();

/** What a disconnect affects, shown with real counts in the level-3 confirmation (UX doc §7). */
export const removalPreviewSchema = z.object({
  bankName: z.string(),
  /** Accounts of the connection that are not removed yet. */
  accounts: count,
  /** Transactions of those accounts; they are kept after the disconnect until purged. */
  transactions: count,
});
export type RemovalPreview = z.infer<typeof removalPreviewSchema>;

export const disconnectResponseSchema = z.object({ removedAccounts: count });
export type DisconnectResponse = z.infer<typeof disconnectResponseSchema>;

/** Purging is permanent, so the body must say so explicitly (spec §6.3). */
export const purgeRequestSchema = z.object({ confirm: z.literal(true) });
export type PurgeRequest = z.infer<typeof purgeRequestSchema>;

export const purgeResponseSchema = z.object({ transactions: count, balances: count });
export type PurgeResponse = z.infer<typeof purgeResponseSchema>;
