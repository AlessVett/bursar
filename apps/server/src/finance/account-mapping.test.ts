import type { AccountStatus } from "@bursar/shared";
import { describe, expect, it } from "vitest";
import {
  accountResource,
  HASH_CARD,
  HASH_CURRENT,
  HASH_SAVINGS,
  IBAN_CURRENT,
  IBAN_SAVINGS,
  testUid,
} from "../test/bank-stub";
import { accountFieldsFromResource, type MappableAccount, mapAccounts } from "./account-mapping";

function stored(
  id: number,
  identificationHash: string,
  iban: string | null,
  status: AccountStatus = "active",
): MappableAccount {
  return { id, identificationHash, iban, status };
}

describe("mapAccounts", () => {
  it("matches an account by its identification hash", () => {
    const current = accountResource("current", { uid: testUid(11) });
    expect(mapAccounts([stored(1, HASH_CURRENT, IBAN_CURRENT)], [current])).toEqual({
      matched: [{ accountId: 1, resource: current }],
      created: [],
      missing: [],
    });
  });

  it("matches by one of the alternate hashes of the incoming account", () => {
    const savings = accountResource("savings", {
      identification_hash: "hash-savings-v2",
      identification_hashes: ["hash-savings-v2", HASH_SAVINGS],
      account_id: null,
      all_account_ids: null,
    });
    expect(mapAccounts([stored(2, HASH_SAVINGS, null)], [savings]).matched).toEqual([
      { accountId: 2, resource: savings },
    ]);
  });

  it("falls back to the IBAN, ignoring spaces and case", () => {
    const moved = accountResource("current", {
      identification_hash: "hash-current-v2",
      identification_hashes: ["hash-current-v2"],
      account_id: { iban: "it89 x990 0101 6000 0000 0001 001" },
    });
    expect(mapAccounts([stored(1, HASH_CURRENT, IBAN_CURRENT)], [moved]).matched).toEqual([
      { accountId: 1, resource: moved },
    ]);
  });

  it("prefers a hash match over an IBAN match", () => {
    // Same hash as account 1, but the IBAN of account 2.
    const incoming = accountResource("current", { account_id: { iban: IBAN_SAVINGS } });
    const result = mapAccounts(
      [stored(2, HASH_SAVINGS, IBAN_SAVINGS), stored(1, HASH_CURRENT, IBAN_CURRENT)],
      [incoming],
    );
    expect(result).toEqual({
      matched: [{ accountId: 1, resource: incoming }],
      created: [],
      missing: [2],
    });
  });

  it("matches each stored account at most once", () => {
    const first = accountResource("current");
    const second = accountResource("current", { uid: testUid(21) });
    expect(mapAccounts([stored(1, HASH_CURRENT, IBAN_CURRENT)], [first, second])).toEqual({
      matched: [{ accountId: 1, resource: first }],
      created: [second],
      missing: [],
    });
  });

  it("can match removed accounts but never reports them as missing", () => {
    const current = accountResource("current");
    const result = mapAccounts(
      [
        stored(1, HASH_CURRENT, IBAN_CURRENT, "removed"),
        stored(2, HASH_SAVINGS, IBAN_SAVINGS, "removed"),
        stored(3, "hash-other", null, "disabled"),
      ],
      [current],
    );
    expect(result).toEqual({
      matched: [{ accountId: 1, resource: current }],
      created: [],
      missing: [3],
    });
  });

  it("creates every incoming account when nothing matches", () => {
    const savings = accountResource("savings");
    expect(mapAccounts([stored(1, "hash-old", null)], [savings])).toEqual({
      matched: [],
      created: [savings],
      missing: [1],
    });
  });
});

describe("accountFieldsFromResource", () => {
  it("extracts the stored fields of an IBAN account", () => {
    expect(accountFieldsFromResource(accountResource("current"))).toEqual({
      providerAccountUid: testUid(1),
      identificationHash: HASH_CURRENT,
      iban: IBAN_CURRENT,
      maskedIdentifier: "IT89 •••• •••• 1001",
      last4: "1001",
      product: "Conto Corrente Esempio",
      details: null,
      currency: "EUR",
      cashAccountType: "CACC",
    });
  });

  it("reads the IBAN from all_account_ids when account_id has none", () => {
    const fields = accountFieldsFromResource(
      accountResource("savings", {
        account_id: null,
        all_account_ids: [
          { identification: "it28 x990 0101 6000 0000 0002 002", scheme_name: "IBAN" },
        ],
      }),
    );
    expect(fields).toMatchObject({
      iban: IBAN_SAVINGS,
      maskedIdentifier: "IT28 •••• •••• 2002",
      last4: "2002",
    });
  });

  it("masks identifiers that are not IBANs, such as card numbers", () => {
    expect(accountFieldsFromResource(accountResource("card"))).toEqual({
      providerAccountUid: null,
      identificationHash: HASH_CARD,
      iban: null,
      maskedIdentifier: "•••• 5678",
      last4: "5678",
      product: "Carta Esempio",
      details: "Carta di credito",
      currency: "EUR",
      cashAccountType: "CARD",
    });
  });

  it("stores nulls for blank values and never the holder name", () => {
    const bare = accountResource("current", {
      uid: "",
      account_id: null,
      all_account_ids: [],
      product: "  ",
      details: "",
    });
    expect(accountFieldsFromResource(bare)).toEqual({
      providerAccountUid: null,
      identificationHash: HASH_CURRENT,
      iban: null,
      maskedIdentifier: null,
      last4: null,
      product: null,
      details: null,
      currency: "EUR",
      cashAccountType: "CACC",
    });
    expect(JSON.stringify(accountFieldsFromResource(accountResource("current")))).not.toContain(
      "Alex Example",
    );
  });
});
