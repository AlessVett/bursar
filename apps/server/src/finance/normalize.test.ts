import { createHash } from "node:crypto";
import { isValidIban, MoneyParseError } from "@bursar/shared";
import { describe, expect, it } from "vitest";
import type { EbBalance, EbTransaction } from "../eb/schemas";
import {
  assignFingerprints,
  normalizeBalance,
  normalizeCounterparty,
  normalizeTransaction,
} from "./normalize";

const FALLBACK = "2026-11-09";
// Fictional IBANs with valid mod-97 checksums on reserved test bank codes (ABI/CAB 99999 99999,
// Bankleitzahl 99999999), like the QA seed's: no real bank or account behind them.
const SUPPLIER_IBAN = "IT03X9999999999000000880001";
const EMPLOYER_IBAN = "DE22999999990000880002";
const REMITTANCE = "Card payment Northwind Grocers store 12";

describe("the fixtures", () => {
  it("use fictional IBANs on reserved test bank codes", () => {
    expect(isValidIban(SUPPLIER_IBAN)).toBe(true);
    expect(isValidIban(EMPLOYER_IBAN)).toBe(true);
    expect(SUPPLIER_IBAN.slice(5, 15)).toBe("9999999999"); // ABI and CAB
    expect(EMPLOYER_IBAN.slice(4, 12)).toBe("99999999"); // Bankleitzahl
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A booked card payment shaped like an Enable Banking `Transaction` (eb-api-notes.md §7). */
function ebTransaction(overrides: Partial<EbTransaction> = {}): EbTransaction {
  return {
    entry_reference: "20261103-0001",
    transaction_id: "c0a8d3f2-91a4-4f7e-9d0b-5a1e2f3c4d5e",
    transaction_amount: { currency: "EUR", amount: "42.50" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    booking_date: "2026-11-03",
    value_date: "2026-11-03",
    transaction_date: "2026-11-02",
    creditor: { name: "Northwind Grocers" },
    creditor_account: { iban: SUPPLIER_IBAN },
    debtor: null,
    debtor_account: null,
    remittance_information: ["Card payment", "Northwind Grocers store 12"],
    bank_transaction_code: { description: "Card payment", code: "PMNT", sub_code: "CCRD" },
    merchant_category_code: "5411",
    balance_after_transaction: { currency: "EUR", amount: "1234.56" },
    reference_number: null,
    ...overrides,
  };
}

/** A `BalanceResource` shaped like `GET /accounts/{uid}/balances` (eb-api-notes.md §7). */
function ebBalance(overrides: Partial<EbBalance> = {}): EbBalance {
  return {
    name: "Interim booked balance",
    balance_amount: { currency: "EUR", amount: "1234.56" },
    balance_type: "ITBD",
    last_change_date_time: "2026-11-08T17:45:00.000000+00:00",
    reference_date: "2026-11-08",
    ...overrides,
  };
}

function normalize(overrides: Partial<EbTransaction> = {}) {
  return normalizeTransaction(ebTransaction(overrides), FALLBACK);
}

describe("normalizeTransaction: amount and sign", () => {
  it("makes DBIT amounts negative and CRDT amounts positive", () => {
    expect(normalize().amountMinor).toBe(-4250);
    expect(normalize({ credit_debit_indicator: "CRDT" }).amountMinor).toBe(4250);
  });

  it("ignores the sign carried by the provider string", () => {
    expect(
      normalize({ transaction_amount: { currency: "EUR", amount: "-42.50" } }).amountMinor,
    ).toBe(-4250);
    expect(
      normalize({
        credit_debit_indicator: "CRDT",
        transaction_amount: { currency: "EUR", amount: "-10.00" },
      }).amountMinor,
    ).toBe(1000);
    expect(
      normalize({ transaction_amount: { currency: "EUR", amount: "+7.00" } }).amountMinor,
    ).toBe(-700);
  });

  it("never produces negative zero", () => {
    const zero = normalize({ transaction_amount: { currency: "EUR", amount: "0.00" } });
    expect(Object.is(zero.amountMinor, 0)).toBe(true);
  });

  it("uses the currency's minor digits and an upper-case currency code", () => {
    expect(normalize({ transaction_amount: { currency: "JPY", amount: "1500" } })).toMatchObject({
      amountMinor: -1500,
      currency: "JPY",
    });
    expect(
      normalize({
        credit_debit_indicator: "CRDT",
        transaction_amount: { currency: "BHD", amount: "1.250" },
      }).amountMinor,
    ).toBe(1250);
    expect(normalize({ transaction_amount: { currency: "eur", amount: "1.00" } }).currency).toBe(
      "EUR",
    );
  });

  it("throws MoneyParseError on an amount that is not a plain decimal", () => {
    expect(() => normalize({ transaction_amount: { currency: "EUR", amount: "42,50" } })).toThrow(
      MoneyParseError,
    );
  });
});

describe("normalizeTransaction: status", () => {
  it.each([
    ["BOOK", "booked"],
    ["PDNG", "pending"],
    ["HOLD", "pending"],
    ["SCHD", "pending"],
    ["OTHR", "pending"],
    ["CNCL", "cancelled"],
    ["RJCT", "cancelled"],
  ] as const)("maps %s to %s", (code, status) => {
    expect(normalize({ status: code }).status).toBe(status);
  });

  it("accepts lower-case codes and treats unknown codes as pending", () => {
    expect(normalize({ status: "book" }).status).toBe("booked");
    expect(normalize({ status: "XXXX" }).status).toBe("pending");
  });
});

describe("normalizeTransaction: counterparty", () => {
  it("takes the creditor for a debit and the debtor for a credit", () => {
    expect(normalize().counterparty).toBe("Northwind Grocers");
    expect(
      normalize({
        credit_debit_indicator: "CRDT",
        creditor: { name: "Bursar Owner" },
        debtor: { name: "  Example   Employer " },
      }).counterparty,
    ).toBe("Example Employer");
  });

  it("returns null when the other side has no usable name", () => {
    expect(normalize({ creditor: null }).counterparty).toBeNull();
    expect(normalize({ creditor: { name: "   " } }).counterparty).toBeNull();
    expect(
      normalize({ credit_debit_indicator: "CRDT", debtor: undefined }).counterparty,
    ).toBeNull();
  });

  it("masks the other side's IBAN", () => {
    expect(normalize().counterpartyAccount).toBe("IT03 •••• •••• 0001");
    expect(
      normalize({
        credit_debit_indicator: "CRDT",
        debtor: { name: "Example Employer" },
        debtor_account: { iban: EMPLOYER_IBAN },
      }).counterpartyAccount,
    ).toBe("DE22 •••• •••• 0002");
  });

  it("masks a non-IBAN identifier and returns null without an account", () => {
    expect(
      normalize({
        creditor_account: {
          iban: null,
          other: { identification: "4000123412347788", scheme_name: "CPAN" },
        },
      }).counterpartyAccount,
    ).toBe("•••• 7788");
    expect(normalize({ creditor_account: null }).counterpartyAccount).toBeNull();
  });
});

describe("normalizeTransaction: remittance, codes and balance", () => {
  it("trims remittance lines, drops empty ones and joins them with a space", () => {
    const tx = normalize({ remittance_information: [" Invoice 42 ", "", "   ", "Order 7"] });
    expect(tx.remittanceLines).toEqual(["Invoice 42", "Order 7"]);
    expect(tx.remittance).toBe("Invoice 42 Order 7");
  });

  it("returns a null remittance without lines", () => {
    for (const lines of [null, [], ["  "]]) {
      const tx = normalize({ remittance_information: lines });
      expect(tx.remittance).toBeNull();
      expect(tx.remittanceLines).toEqual([]);
    }
  });

  it("keeps the bank transaction code and the merchant category code", () => {
    expect(normalize()).toMatchObject({
      bankCode: { code: "PMNT", subCode: "CCRD", description: "Card payment" },
      merchantCategoryCode: "5411",
    });
    expect(
      normalize({
        bank_transaction_code: { code: null, sub_code: null, description: "  " },
        merchant_category_code: null,
      }),
    ).toMatchObject({ bankCode: null, merchantCategoryCode: null });
  });

  it("parses the balance after the transaction only in the transaction currency", () => {
    expect(normalize().balanceAfterMinor).toBe(123456);
    expect(
      normalize({ balance_after_transaction: { currency: "USD", amount: "10.00" } })
        .balanceAfterMinor,
    ).toBeNull();
    expect(
      normalize({ balance_after_transaction: { currency: "EUR", amount: "12,00" } })
        .balanceAfterMinor,
    ).toBeNull();
    expect(normalize({ balance_after_transaction: null }).balanceAfterMinor).toBeNull();
  });
});

describe("normalizeTransaction: references and dates", () => {
  it("uses entry_reference and never transaction_id", () => {
    expect(normalize({ entry_reference: " 20261103-0001 " }).providerReference).toBe(
      "20261103-0001",
    );
    expect(
      normalize({ entry_reference: null, transaction_id: "TX-UNSTABLE-1" }).providerReference,
    ).toBeNull();
  });

  it("computes the sort date from booking, value and transaction date, then the fallback", () => {
    expect(normalize().sortDate).toBe("2026-11-03");
    expect(normalize({ booking_date: null, value_date: "2026-11-04" }).sortDate).toBe("2026-11-04");
    expect(normalize({ booking_date: null, value_date: null }).sortDate).toBe("2026-11-02");
    expect(
      normalize({ booking_date: undefined, value_date: undefined, transaction_date: undefined }),
    ).toMatchObject({
      bookingDate: null,
      valueDate: null,
      transactionDate: null,
      sortDate: FALLBACK,
    });
  });

  it("drops dates that are not real calendar dates", () => {
    expect(
      normalize({
        booking_date: "2026-02-30",
        value_date: "03/11/2026",
        transaction_date: "2026-11-02T10:15:00",
      }),
    ).toMatchObject({
      bookingDate: null,
      valueDate: null,
      transactionDate: "2026-11-02",
      sortDate: "2026-11-02",
    });
  });

  it("rejects an invalid fallback date", () => {
    expect(() => normalizeTransaction(ebTransaction(), "2026-13-01")).toThrow(RangeError);
  });
});

describe("normalizeTransaction: search text and raw data", () => {
  it("builds accent-free lower-case search text from counterparty and remittance", () => {
    expect(
      normalize({
        creditor: { name: "Caffè  Roma" },
        remittance_information: ["Colazione", "BAR Centrale"],
      }).searchText,
    ).toBe("caffe roma colazione bar centrale");
    expect(normalize({ creditor: null, remittance_information: ["ATM 0042"] }).searchText).toBe(
      "atm 0042",
    );
  });

  it("keeps the raw provider transaction", () => {
    const raw = ebTransaction();
    expect(normalizeTransaction(raw, FALLBACK).raw).toBe(raw);
  });
});

describe("normalizeCounterparty", () => {
  it("lower-cases, strips accents and collapses spaces", () => {
    expect(normalizeCounterparty("  Caffè   ROMA ")).toBe("caffe roma");
    expect(normalizeCounterparty(null)).toBe("");
  });
});

describe("assignFingerprints", () => {
  it("uses the entry reference when present", () => {
    expect(assignFingerprints(7, [normalize()])[0]?.fingerprint).toBe("ref:20261103-0001");
  });

  it("hashes account, booking date, amount, currency, counterparty and remittance", () => {
    const expected = sha256(
      ["7", "2026-11-03", "-4250", "EUR", "northwind grocers", sha256(REMITTANCE)].join("|"),
    );
    expect(assignFingerprints(7, [normalize({ entry_reference: null })])[0]?.fingerprint).toBe(
      `fp:${expected}#1`,
    );
  });

  it("falls back to the sort date when there is no booking date", () => {
    const expected = sha256(
      ["7", "2026-11-04", "-4250", "EUR", "northwind grocers", sha256(REMITTANCE)].join("|"),
    );
    const pending = normalize({
      entry_reference: null,
      status: "PDNG",
      booking_date: null,
      value_date: "2026-11-04",
    });
    expect(assignFingerprints(7, [pending])[0]?.fingerprint).toBe(`pending:${expected}#1`);
  });

  it("prefixes pending and cancelled entries with pending: and shares their counter", () => {
    const [booked, pending, cancelled] = assignFingerprints(7, [
      normalize({ entry_reference: null }),
      normalize({ entry_reference: null, status: "PDNG" }),
      normalize({ entry_reference: null, status: "CNCL" }),
    ]);
    expect(booked?.fingerprint).toMatch(/^fp:[0-9a-f]{64}#1$/);
    expect(pending?.fingerprint).toMatch(/^pending:[0-9a-f]{64}#1$/);
    expect(pending?.fingerprint.slice("pending:".length, -2)).toBe(
      booked?.fingerprint.slice("fp:".length, -2),
    );
    expect(cancelled?.fingerprint).toMatch(/^pending:[0-9a-f]{64}#2$/);
  });

  it("numbers identical transactions in provider order and stays stable", () => {
    const batch = [normalize({ entry_reference: null }), normalize({ entry_reference: null })];
    const first = assignFingerprints(7, batch).map((tx) => tx.fingerprint);
    expect(first[0]?.endsWith("#1")).toBe(true);
    expect(first[1]?.endsWith("#2")).toBe(true);
    expect(first[0]?.slice(0, -2)).toBe(first[1]?.slice(0, -2));
    expect(assignFingerprints(7, batch).map((tx) => tx.fingerprint)).toEqual(first);
  });

  it("separates accounts and remittances but ignores counterparty case and accents", () => {
    const base = normalize({ entry_reference: null });
    const [a] = assignFingerprints(7, [base]);
    const [otherAccount] = assignFingerprints(8, [base]);
    const [otherRemittance] = assignFingerprints(7, [
      normalize({ entry_reference: null, remittance_information: ["Card payment"] }),
    ]);
    const [shouted] = assignFingerprints(7, [
      normalize({ entry_reference: null, creditor: { name: "  NORTHWIND   grocers " } }),
    ]);
    expect(otherAccount?.fingerprint).not.toBe(a?.fingerprint);
    expect(otherRemittance?.fingerprint).not.toBe(a?.fingerprint);
    expect(shouted?.fingerprint).toBe(a?.fingerprint);
  });

  it("does not mutate its input", () => {
    const input = [normalize()];
    const output = assignFingerprints(7, input);
    expect(input[0]).not.toHaveProperty("fingerprint");
    expect(output[0]).toEqual({ ...input[0], fingerprint: "ref:20261103-0001" });
  });

  it("leaves the fallback day out of the key of an entry without any provider date", () => {
    const dateless = ebTransaction({
      entry_reference: null,
      status: "PDNG",
      booking_date: null,
      value_date: null,
      transaction_date: null,
    });
    const [today] = assignFingerprints(7, [normalizeTransaction(dateless, "2026-11-09")]);
    const [tomorrow] = assignFingerprints(7, [normalizeTransaction(dateless, "2026-11-10")]);
    expect(today?.sortDate).toBe("2026-11-09");
    expect(tomorrow?.sortDate).toBe("2026-11-10");
    expect(tomorrow?.fingerprint).toBe(today?.fingerprint);
    const expected = sha256(
      ["7", "nodate", "-4250", "EUR", "northwind grocers", sha256(REMITTANCE)].join("|"),
    );
    expect(today?.fingerprint).toBe(`pending:${expected}#1`);
  });
});

describe("normalizeBalance", () => {
  const FETCHED_AT = Date.UTC(2026, 10, 9, 7, 0, 0);

  it("converts the amount and keeps the reference date and the change time", () => {
    expect(normalizeBalance(ebBalance(), FETCHED_AT, "Europe/Rome")).toEqual({
      balanceType: "ITBD",
      amountMinor: 123456,
      currency: "EUR",
      referenceDate: "2026-11-08",
      asOf: Date.UTC(2026, 10, 8, 17, 45, 0),
    });
  });

  it("keeps negative balances and upper-cases the balance type", () => {
    expect(
      normalizeBalance(
        ebBalance({ balance_type: "clbd", balance_amount: { currency: "EUR", amount: "-50.00" } }),
        FETCHED_AT,
        "Europe/Rome",
      ),
    ).toMatchObject({ balanceType: "CLBD", amountMinor: -5000 });
  });

  it("derives the reference date from the change time in the configured time zone", () => {
    expect(
      normalizeBalance(
        ebBalance({ reference_date: null, last_change_date_time: "2026-11-08T23:30:00Z" }),
        FETCHED_AT,
        "Europe/Rome",
      ),
    ).toMatchObject({ referenceDate: "2026-11-09", asOf: Date.UTC(2026, 10, 8, 23, 30, 0) });
  });

  it("falls back to the fetch time without dates", () => {
    expect(
      normalizeBalance(
        ebBalance({ reference_date: null, last_change_date_time: null }),
        FETCHED_AT,
        "Europe/Rome",
      ),
    ).toMatchObject({ referenceDate: "2026-11-09", asOf: FETCHED_AT });
  });

  it("ignores a change time without a UTC offset and an invalid reference date", () => {
    expect(
      normalizeBalance(
        ebBalance({ reference_date: "2026-13-01", last_change_date_time: "2026-11-08T17:45:00" }),
        FETCHED_AT,
        "Europe/Rome",
      ),
    ).toMatchObject({ referenceDate: "2026-11-09", asOf: FETCHED_AT });
  });
});
