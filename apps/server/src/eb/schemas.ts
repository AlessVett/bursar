import { z } from "zod";

/**
 * Enable Banking response shapes (eb-api-notes.md §1–§7). Objects pass unknown fields through so
 * a new provider field never breaks a sync; optional fields accept `null` as well as absence.
 */

export const ebGenericIdentificationSchema = z
  .object({
    identification: z.string(),
    scheme_name: z.string(),
    issuer: z.string().nullish(),
  })
  .passthrough();
export type EbGenericIdentification = z.infer<typeof ebGenericIdentificationSchema>;

export const ebAccountIdentificationSchema = z
  .object({
    iban: z.string().nullish(),
    other: ebGenericIdentificationSchema.nullish(),
  })
  .passthrough();
export type EbAccountIdentification = z.infer<typeof ebAccountIdentificationSchema>;

export const ebAmountSchema = z.object({ currency: z.string(), amount: z.string() }).passthrough();
export type EbAmount = z.infer<typeof ebAmountSchema>;

export const ebApplicationSchema = z
  .object({
    name: z.string(),
    kid: z.string(),
    environment: z.enum(["SANDBOX", "PRODUCTION"]),
    redirect_urls: z.array(z.string()),
    active: z.boolean(),
    countries: z.array(z.string()),
  })
  .passthrough();
export type EbApplication = z.infer<typeof ebApplicationSchema>;

export const ebAspspSchema = z
  .object({
    name: z.string(),
    country: z.string(),
    logo: z.string(),
    psu_types: z.array(z.string()),
    maximum_consent_validity: z.number().int().nonnegative(),
    beta: z.boolean(),
    bic: z.string().nullish(),
    required_psu_headers: z.array(z.string()).nullish(),
  })
  .passthrough();
export type EbAspsp = z.infer<typeof ebAspspSchema>;

export const ebAspspListSchema = z.object({ aspsps: z.array(ebAspspSchema) }).passthrough();

export const ebStartAuthorizationRequestSchema = z.object({
  access: z.object({
    valid_until: z.string(),
    balances: z.boolean().optional(),
    transactions: z.boolean().optional(),
  }),
  aspsp: z.object({ name: z.string(), country: z.string() }),
  state: z.string(),
  redirect_url: z.string(),
  psu_type: z.literal("personal"),
  language: z.string().optional(),
});
export type EbStartAuthorizationRequest = z.infer<typeof ebStartAuthorizationRequestSchema>;

export const ebStartAuthorizationResponseSchema = z
  .object({
    url: z.string(),
    authorization_id: z.string(),
    psu_id_hash: z.string().nullish(),
  })
  .passthrough();
export type EbStartAuthorizationResponse = z.infer<typeof ebStartAuthorizationResponseSchema>;

export const ebAccountResourceSchema = z
  .object({
    uid: z.string().nullish(),
    account_id: ebAccountIdentificationSchema.nullish(),
    all_account_ids: z.array(ebGenericIdentificationSchema).nullish(),
    account_servicer: z
      .object({ bic_fi: z.string().nullish(), name: z.string().nullish() })
      .passthrough()
      .nullish(),
    name: z.string().nullish(),
    details: z.string().nullish(),
    product: z.string().nullish(),
    cash_account_type: z.string(),
    currency: z.string(),
    identification_hash: z.string(),
    identification_hashes: z.array(z.string()),
    usage: z.string().nullish(),
  })
  .passthrough();
export type EbAccountResource = z.infer<typeof ebAccountResourceSchema>;

const ebAspspRefSchema = z.object({ name: z.string(), country: z.string() }).passthrough();
const ebAccessSchema = z.object({ valid_until: z.string() }).passthrough();

export const ebSessionSchema = z
  .object({
    session_id: z.string(),
    accounts: z.array(ebAccountResourceSchema),
    aspsp: ebAspspRefSchema,
    psu_type: z.string(),
    access: ebAccessSchema,
  })
  .passthrough();
export type EbSession = z.infer<typeof ebSessionSchema>;

export const ebSessionStatusSchema = z
  .object({
    status: z.enum([
      "INVALID",
      "PENDING_AUTHORIZATION",
      "RETURNED_FROM_BANK",
      "AUTHORIZED",
      "EXPIRED",
      "CLOSED",
      "REVOKED",
      "CANCELLED",
    ]),
    accounts: z.array(z.string()),
    access: ebAccessSchema,
  })
  .passthrough();
export type EbSessionStatus = z.infer<typeof ebSessionStatusSchema>;

export const ebBalanceSchema = z
  .object({
    name: z.string(),
    balance_amount: ebAmountSchema,
    balance_type: z.string(),
    last_change_date_time: z.string().nullish(),
    reference_date: z.string().nullish(),
  })
  .passthrough();
export type EbBalance = z.infer<typeof ebBalanceSchema>;

/**
 * The balances envelope. Items are checked one by one in the client (`ebBalanceSchema.safeParse`),
 * so one malformed balance is dropped instead of failing the whole account sync.
 */
export const ebBalancesResponseSchema = z.object({ balances: z.array(z.unknown()) }).passthrough();

const ebPartySchema = z.object({ name: z.string().nullish() }).passthrough();

export const ebTransactionSchema = z
  .object({
    entry_reference: z.string().nullish(),
    transaction_id: z.string().nullish(),
    transaction_amount: ebAmountSchema,
    credit_debit_indicator: z.enum(["CRDT", "DBIT"]),
    status: z.string(),
    booking_date: z.string().nullish(),
    value_date: z.string().nullish(),
    transaction_date: z.string().nullish(),
    creditor: ebPartySchema.nullish(),
    debtor: ebPartySchema.nullish(),
    creditor_account: ebAccountIdentificationSchema.nullish(),
    debtor_account: ebAccountIdentificationSchema.nullish(),
    remittance_information: z.array(z.string()).nullish(),
    bank_transaction_code: z
      .object({
        description: z.string().nullish(),
        code: z.string().nullish(),
        sub_code: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    merchant_category_code: z.string().nullish(),
    balance_after_transaction: ebAmountSchema.nullish(),
    reference_number: z.string().nullish(),
  })
  .passthrough();
export type EbTransaction = z.infer<typeof ebTransactionSchema>;

export const ebTransactionsPageSchema = z
  .object({
    transactions: z.array(ebTransactionSchema),
    continuation_key: z.string().nullish(),
  })
  .passthrough();

/**
 * The page envelope as it arrives: items are checked one by one in the client
 * (`ebTransactionSchema.safeParse`), so one deviating entry (an unknown `credit_debit_indicator`,
 * a missing amount) is dropped and counted instead of failing the whole account sync.
 */
export const ebTransactionsPageEnvelopeSchema = z
  .object({
    transactions: z.array(z.unknown()),
    continuation_key: z.string().nullish(),
  })
  .passthrough();

export type EbTransactionsPage = z.infer<typeof ebTransactionsPageSchema> & {
  /** Items of this page the client dropped because they did not match `ebTransactionSchema`. */
  skipped?: number;
};
