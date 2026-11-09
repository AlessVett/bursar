import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 12;

export const totpCodeSchema = z.string().regex(/^\d{6}$/, "TOTP code must be 6 digits");

export const setupStartRequestSchema = z.object({
  setupCode: z.string().trim().min(1).max(128),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(256),
});
export type SetupStartRequest = z.infer<typeof setupStartRequestSchema>;

export const setupStartResponseSchema = z.object({
  setupToken: z.string(),
  otpauthUri: z.string(),
  secret: z.string(),
});
export type SetupStartResponse = z.infer<typeof setupStartResponseSchema>;

export const setupConfirmRequestSchema = z.object({
  setupToken: z.string().min(1),
  code: totpCodeSchema,
});
export type SetupConfirmRequest = z.infer<typeof setupConfirmRequestSchema>;

export const loginRequestSchema = z.object({
  password: z.string().min(1).max(256),
  code: totpCodeSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authStatusSchema = z.object({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;
