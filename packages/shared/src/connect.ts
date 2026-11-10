import { z } from "zod";
import type { AccountStatus } from "./finance";

/** Body of `POST /api/connections`: the bank exactly as `GET /api/banks/aspsps` lists it. */
export const startConnectionRequestSchema = z.object({
  aspspName: z.string().min(1).max(200),
  aspspCountry: z.string().regex(/^[A-Z]{2}$/),
  consentDays: z.number().int().min(1).max(365).optional(),
});
export type StartConnectionRequest = z.infer<typeof startConnectionRequestSchema>;

/** Body of `POST /api/connections/:connectionId/renew`. */
export const renewConnectionRequestSchema = z.object({
  consentDays: z.number().int().min(1).max(365).optional(),
});
export type RenewConnectionRequest = z.infer<typeof renewConnectionRequestSchema>;

export interface StartConnectionResponse {
  /** The bank's consent page; the panel navigates the whole window to it. */
  redirectUrl: string;
}

/** Body of `POST /api/connections/complete`: the callback parameters the panel page received. */
export const completeConnectionRequestSchema = z.object({
  state: z.string().min(16).max(256),
  code: z.string().max(512).optional(),
  error: z.string().max(200).optional(),
  errorDescription: z.string().max(512).optional(),
});
export type CompleteConnectionRequest = z.infer<typeof completeConnectionRequestSchema>;

export type ConnectOutcome = "connected" | "renewed" | "no_accounts" | "denied" | "failed";

export interface ConnectedAccount {
  id: number;
  name: string;
  maskedIdentifier: string | null;
  currency: string;
  status: AccountStatus;
}

export interface CompleteConnectionResponse {
  outcome: ConnectOutcome;
  connectionId: number | null;
  bankName: string;
  accounts: ConnectedAccount[];
  /** Enable Banking or callback error code for `failed`; null otherwise. */
  errorCode: string | null;
}
