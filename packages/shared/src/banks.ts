import { z } from "zod";

const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

export const aspspSummarySchema = z.object({
  name: z.string(),
  country: z.string(),
  maximumConsentDays: z.number().int(),
  beta: z.boolean(),
  hasLogo: z.boolean(),
});
export type AspspSummary = z.infer<typeof aspspSummarySchema>;

export const aspspListResponseSchema = z.object({ aspsps: z.array(aspspSummarySchema) });
export type AspspListResponse = z.infer<typeof aspspListResponseSchema>;

export const bankStatusResponseSchema = z.object({
  configured: z.boolean(),
  environment: z.enum(["SANDBOX", "PRODUCTION"]).nullable(),
  active: z.boolean().nullable(),
  redirectUrlAllowed: z.boolean().nullable(),
  countries: z.array(z.string()),
  error: z.string().nullable(),
});
export type BankStatusResponse = z.infer<typeof bankStatusResponseSchema>;

export const aspspQuerySchema = z.object({ country: countryCodeSchema });
export type AspspQuery = z.infer<typeof aspspQuerySchema>;

export const logoQuerySchema = z.object({
  country: countryCodeSchema,
  name: z.string().min(1).max(200),
});
export type LogoQuery = z.infer<typeof logoQuerySchema>;
