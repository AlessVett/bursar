import {
  type AccountStatus,
  identifierLast4,
  maskIban,
  maskIdentifier,
  normalizeIban,
} from "@bursar/shared";
import type { EbAccountResource } from "../eb/schemas";

/** The identity of a stored account, as far as matching a bank's account list needs it. */
export interface MappableAccount {
  id: number;
  identificationHash: string;
  iban: string | null;
  status: AccountStatus;
}

export interface AccountMapping {
  /** Incoming accounts that are an existing account, in the bank's order. */
  matched: { accountId: number; resource: EbAccountResource }[];
  /** Incoming accounts that match no existing account, in the bank's order. */
  created: EbAccountResource[];
  /** Existing accounts (not `removed`) that the bank no longer returns. */
  missing: number[];
}

/** The account columns that come from the bank. The holder `name` is never stored. */
export interface AccountFields {
  providerAccountUid: string | null;
  identificationHash: string;
  iban: string | null;
  maskedIdentifier: string | null;
  last4: string | null;
  product: string | null;
  details: string | null;
  currency: string;
  cashAccountType: string | null;
}

type Matcher = (account: MappableAccount, resource: EbAccountResource) => boolean;

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The account's IBAN (normalised), from `account_id` or else from `all_account_ids`. */
function resourceIban(resource: EbAccountResource): string | null {
  const iban =
    nonEmpty(resource.account_id?.iban) ??
    nonEmpty(resource.all_account_ids?.find((id) => id.scheme_name === "IBAN")?.identification);
  return iban === null ? null : normalizeIban(iban);
}

/** A non-IBAN identifier (card number, BBAN…), used only for the masked label. */
function resourceOtherIdentifier(resource: EbAccountResource): string | null {
  return (
    nonEmpty(resource.account_id?.other?.identification) ??
    nonEmpty(resource.all_account_ids?.find((id) => id.scheme_name !== "IBAN")?.identification)
  );
}

/**
 * Matching passes, strongest first: the bank's stable `identification_hash`, then any of the
 * alternate `identification_hashes`, then the IBAN. A later pass only sees what is still unmatched,
 * so a hash match always wins over an IBAN match.
 */
const MATCHERS: readonly Matcher[] = [
  (account, resource) => account.identificationHash === resource.identification_hash,
  (account, resource) => resource.identification_hashes.includes(account.identificationHash),
  (account, resource) => {
    const iban = resourceIban(resource);
    return iban !== null && account.iban !== null && normalizeIban(account.iban) === iban;
  },
];

/**
 * Maps the accounts a bank returned for a new session onto stored accounts. Each stored account is
 * matched at most once; `removed` accounts can be matched (re-attachment) but are never `missing`.
 */
export function mapAccounts(
  existing: readonly MappableAccount[],
  incoming: readonly EbAccountResource[],
): AccountMapping {
  const assigned = new Map<number, number>();
  const used = new Set<number>();
  for (const matches of MATCHERS) {
    for (const [index, resource] of incoming.entries()) {
      if (assigned.has(index)) continue;
      const account = existing.find(
        (candidate) => !used.has(candidate.id) && matches(candidate, resource),
      );
      if (!account) continue;
      used.add(account.id);
      assigned.set(index, account.id);
    }
  }
  const matched: AccountMapping["matched"] = [];
  const created: EbAccountResource[] = [];
  for (const [index, resource] of incoming.entries()) {
    const accountId = assigned.get(index);
    if (accountId === undefined) created.push(resource);
    else matched.push({ accountId, resource });
  }
  const missing = existing
    .filter((account) => !used.has(account.id) && account.status !== "removed")
    .map((account) => account.id);
  return { matched, created, missing };
}

/** The columns to store for a bank account: masked identifier and last four only for display. */
export function accountFieldsFromResource(resource: EbAccountResource): AccountFields {
  const iban = resourceIban(resource);
  const other = iban === null ? resourceOtherIdentifier(resource) : null;
  const shown = iban ?? other;
  let maskedIdentifier: string | null = null;
  if (iban !== null) maskedIdentifier = maskIban(iban);
  else if (other !== null) maskedIdentifier = maskIdentifier(other);
  return {
    providerAccountUid: nonEmpty(resource.uid),
    identificationHash: resource.identification_hash,
    iban,
    maskedIdentifier,
    last4: shown === null ? null : identifierLast4(shown),
    product: nonEmpty(resource.product),
    details: nonEmpty(resource.details),
    currency: resource.currency,
    cashAccountType: nonEmpty(resource.cash_account_type),
  };
}
