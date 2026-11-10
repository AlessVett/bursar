/**
 * IBAN helpers. Validation checks the country's registered length and the ISO 7064 mod-97 checksum.
 * Masking keeps only what the panel may show: country, check digits and the last four characters.
 */

/** Total IBAN length per country, from the SWIFT IBAN registry: country code followed by the length. */
const IBAN_LENGTHS: ReadonlyMap<string, number> = new Map(
  `AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24
   DE22 DJ27 DK18 DO28 EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27
   GT28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20
   LV21 LY25 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24 PL28
   PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 SV28
   TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30`
    .split(/\s+/)
    .map((entry): [string, number] => [entry.slice(0, 2), Number(entry.slice(2))]),
);

const BULLET_GROUP = "••••";

/** Uppercase with every whitespace character removed. */
export function normalizeIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** Remainder modulo 97 of the rearranged IBAN, digit by digit so no big number is needed. */
function mod97(rearranged: string): number {
  let remainder = 0;
  for (const char of rearranged) {
    const digits = char >= "A" && char <= "Z" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

/** True when the value (spaces and case ignored) has a registered length for its country and a valid checksum. */
export function isValidIban(value: string): boolean {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  if (IBAN_LENGTHS.get(iban.slice(0, 2)) !== iban.length) return false;
  const checkDigits = Number(iban.slice(2, 4));
  if (checkDigits < 2 || checkDigits > 98) return false;
  return mod97(iban.slice(4) + iban.slice(0, 4)) === 1;
}

/** Groups of four characters separated by spaces: `IT05 A010 …`. */
export function formatIban(iban: string): string {
  return (normalizeIban(iban).match(/.{1,4}/g) ?? []).join(" ");
}

/** Last four characters of an identifier (spaces and case ignored); the whole value when it is shorter. */
export function identifierLast4(identifier: string): string {
  return normalizeIban(identifier).slice(-4);
}

/** `•••• 1234` for identifiers that are not IBANs (card or account numbers). */
export function maskIdentifier(identifier: string): string {
  const last4 = identifierLast4(identifier);
  return last4 === "" ? BULLET_GROUP : `${BULLET_GROUP} ${last4}`;
}

/**
 * `IT05 •••• •••• 1234`: country and check digits, two fixed bullet groups whatever the length,
 * last four characters. Values too short to be an IBAN fall back to `maskIdentifier`.
 */
export function maskIban(iban: string): string {
  const normalized = normalizeIban(iban);
  if (normalized.length < 12) return maskIdentifier(normalized);
  return `${normalized.slice(0, 4)} ${BULLET_GROUP} ${BULLET_GROUP} ${normalized.slice(-4)}`;
}

/** Privacy mode: replaces the digits still visible in a masked IBAN or identifier with bullets (`IT•• •••• •••• ••••`). */
export function maskIbanDigitsForPrivacy(masked: string): string {
  return masked.replace(/\d/g, "•");
}
