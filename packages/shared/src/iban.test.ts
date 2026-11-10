import { describe, expect, it } from "vitest";
import {
  formatIban,
  identifierLast4,
  isValidIban,
  maskIban,
  maskIbanDigitsForPrivacy,
  maskIdentifier,
  normalizeIban,
} from "./iban";

// Fictional IBANs: made-up bank and account parts with correct ISO 7064 check digits.
const VALID = {
  IT: "IT05A0100000000000000001234",
  IT2: "IT76B0200000000000000005678",
  DE: "DE54100000000000012345",
  GB: "GB98TEST00000000123456",
  FR: "FR8430000000000000000123456",
  NL: "NL73TEST0000012345",
  ES: "ES5900000000000000012345",
  NO: "NO8700000012345",
  MT: "MT27TEST00000000000000000012345",
  BH: "BH09TEST00000000012345",
} as const;

describe("normalizeIban", () => {
  it("uppercases and removes every whitespace character", () => {
    expect(normalizeIban(" it05 a010\t0000 0000\u00a00000 0001 2 34 ")).toBe(VALID.IT);
  });
});

describe("isValidIban", () => {
  it.each(Object.entries(VALID))("accepts the fictional %s IBAN", (_country, iban) => {
    expect(isValidIban(iban)).toBe(true);
  });

  it("accepts lowercase and spaced input", () => {
    expect(isValidIban(VALID.IT.toLowerCase())).toBe(true);
    expect(isValidIban("IT05 A010 0000 0000 0000 0001 234")).toBe(true);
    expect(isValidIban("  de54 1000 0000 0000 0123 45  ")).toBe(true);
  });

  it("rejects a wrong checksum", () => {
    expect(isValidIban("IT06A0100000000000000001234")).toBe(false);
    expect(isValidIban("IT05A0100000000000000001235")).toBe(false);
  });

  it("rejects a wrong length for the country", () => {
    expect(isValidIban(VALID.IT.slice(0, -1))).toBe(false);
    expect(isValidIban(`${VALID.IT}0`)).toBe(false);
    expect(isValidIban(VALID.DE.slice(0, -2))).toBe(false);
  });

  it("rejects unknown countries, bad characters and empty input", () => {
    expect(isValidIban("ZZ0012345678901234")).toBe(false);
    expect(isValidIban("IT05A01000000000000000-1234")).toBe(false);
    expect(isValidIban("1T05A0100000000000000001234")).toBe(false);
    expect(isValidIban("IT0XA0100000000000000001234")).toBe(false);
    expect(isValidIban("")).toBe(false);
    expect(isValidIban("   ")).toBe(false);
  });

  it("rejects the reserved check digits 00, 01 and 99", () => {
    expect(isValidIban("IT00A0100000000000000001234")).toBe(false);
    expect(isValidIban("IT01A0100000000000000001234")).toBe(false);
    expect(isValidIban("IT99A0100000000000000001234")).toBe(false);
  });
});

describe("formatIban", () => {
  it("groups by four characters", () => {
    expect(formatIban(VALID.IT)).toBe("IT05 A010 0000 0000 0000 0001 234");
    expect(formatIban(VALID.DE)).toBe("DE54 1000 0000 0000 0123 45");
    expect(formatIban(VALID.NO)).toBe("NO87 0000 0012 345");
  });

  it("normalises before grouping and is idempotent", () => {
    const once = formatIban(" it05a0100000000000000001234 ");
    expect(once).toBe("IT05 A010 0000 0000 0000 0001 234");
    expect(formatIban(once)).toBe(once);
    expect(formatIban("")).toBe("");
  });
});

describe("maskIban", () => {
  it("keeps country, check digits and the last four with two fixed bullet groups", () => {
    expect(maskIban(VALID.IT)).toBe("IT05 •••• •••• 1234");
    expect(maskIban(VALID.DE)).toBe("DE54 •••• •••• 2345");
    expect(maskIban(VALID.NO)).toBe("NO87 •••• •••• 2345");
    expect(maskIban(VALID.MT)).toBe("MT27 •••• •••• 2345");
  });

  it("gives the same shape whatever the length or the formatting", () => {
    expect(maskIban(formatIban(VALID.IT))).toBe(maskIban(VALID.IT));
    expect(maskIban(VALID.IT.toLowerCase())).toBe(maskIban(VALID.IT));
    expect(maskIban(VALID.NO)).toHaveLength(maskIban(VALID.MT).length);
  });

  it("never leaks the middle of the number", () => {
    const masked = maskIban(VALID.IT);
    expect(masked).not.toContain("A010");
    expect(masked).not.toContain("0000");
  });

  it("falls back to the identifier mask for values too short to be an IBAN", () => {
    expect(maskIban("12345678")).toBe("•••• 5678");
    expect(maskIban("")).toBe("••••");
  });
});

describe("maskIdentifier and identifierLast4", () => {
  it("masks non-IBAN identifiers down to the last four characters", () => {
    expect(maskIdentifier("4111 1111 1111 1234")).toBe("•••• 1234");
    expect(maskIdentifier("acct-000987")).toBe("•••• 0987");
    expect(maskIdentifier("12")).toBe("•••• 12");
    expect(maskIdentifier("")).toBe("••••");
  });

  it("returns the last four characters, spaces and case ignored", () => {
    expect(identifierLast4(VALID.IT)).toBe("1234");
    expect(identifierLast4("ab cd 12 ef")).toBe("12EF");
    expect(identifierLast4("xy")).toBe("XY");
  });
});

describe("maskIbanDigitsForPrivacy", () => {
  it("replaces the remaining digits with bullets", () => {
    expect(maskIbanDigitsForPrivacy(maskIban(VALID.IT))).toBe("IT•• •••• •••• ••••");
    expect(maskIbanDigitsForPrivacy(maskIdentifier("acct-000987"))).toBe("•••• ••••");
  });

  it("leaves text without digits alone", () => {
    expect(maskIbanDigitsForPrivacy("•••• ••••")).toBe("•••• ••••");
    expect(maskIbanDigitsForPrivacy("")).toBe("");
  });
});
