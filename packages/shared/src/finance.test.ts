import { describe, expect, it } from "vitest";
import {
  accountDisplayName,
  accountStatusSchema,
  CASH_ACCOUNT_TYPE_LABELS,
  connectionStatusSchema,
  EXPIRING_THRESHOLD_DAYS,
  effectiveConnectionStatus,
  isIncludedInTotals,
  notificationEventSchema,
  PREFERRED_BALANCE_TYPES,
  pickPreferredBalance,
  skipReasonSchema,
  storedConnectionStatusSchema,
  syncRunStatusSchema,
  syncTriggerSchema,
  transactionStatusSchema,
  URGENT_THRESHOLD_DAYS,
} from "./finance";

const ROME = "Europe/Rome";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);

describe("status schemas", () => {
  it("accept exactly the documented values", () => {
    expect(storedConnectionStatusSchema.options).toEqual(["active", "expired", "revoked", "error"]);
    expect(connectionStatusSchema.options).toEqual([
      "active",
      "expiring",
      "expired",
      "revoked",
      "error",
    ]);
    expect(accountStatusSchema.options).toEqual(["active", "disabled", "unavailable", "removed"]);
    expect(syncTriggerSchema.options).toEqual(["initial", "manual", "background", "renewal"]);
    expect(syncRunStatusSchema.options).toEqual(["running", "succeeded", "failed", "skipped"]);
    expect(skipReasonSchema.options).toEqual([
      "rate_limited",
      "daily_cap",
      "connection_inactive",
      "account_inactive",
      "no_provider_uid",
    ]);
    expect(transactionStatusSchema.options).toEqual(["booked", "pending"]);
    expect(notificationEventSchema.options).toEqual([
      "consent_expiring",
      "consent_expired",
      "connection_error",
      "sync_failing",
      "backup_failing",
    ]);
  });

  it("keeps the thresholds the lifecycle relies on", () => {
    expect(EXPIRING_THRESHOLD_DAYS).toBe(14);
    expect(URGENT_THRESHOLD_DAYS).toBe(3);
  });
});

describe("effectiveConnectionStatus", () => {
  it("lets a stored non-active status win over the date", () => {
    for (const stored of ["revoked", "error", "expired"] as const) {
      expect(effectiveConnectionStatus(stored, NOW + 90 * DAY, NOW, ROME)).toBe(stored);
    }
  });

  it("is expired exactly at validUntil and after it", () => {
    expect(effectiveConnectionStatus("active", NOW, NOW, ROME)).toBe("expired");
    expect(effectiveConnectionStatus("active", NOW - 1, NOW, ROME)).toBe("expired");
    expect(effectiveConnectionStatus("active", NOW + 1, NOW, ROME)).toBe("expiring");
  });

  it("is expiring at 14 calendar days and active at 15", () => {
    // 2026-11-23 and 2026-11-24 at 12:00 UTC are 14 and 15 calendar days after 2026-11-09 in Rome.
    expect(effectiveConnectionStatus("active", Date.UTC(2026, 10, 23, 12), NOW, ROME)).toBe(
      "expiring",
    );
    expect(effectiveConnectionStatus("active", Date.UTC(2026, 10, 24, 12), NOW, ROME)).toBe(
      "active",
    );
  });

  it("counts local calendar days, not blocks of 24 hours", () => {
    const lateEvening = Date.UTC(2026, 10, 9, 22, 30); // 23:30 in Rome
    // 23:45 Rome on the 23rd: 14 calendar days away.
    expect(
      effectiveConnectionStatus("active", Date.UTC(2026, 10, 23, 22, 45), lateEvening, ROME),
    ).toBe("expiring");
    // 00:15 Rome on the 24th: 15 calendar days away although only 14 days and 45 minutes later.
    expect(
      effectiveConnectionStatus("active", Date.UTC(2026, 10, 23, 23, 15), lateEvening, ROME),
    ).toBe("active");
  });
});

describe("pickPreferredBalance", () => {
  it("returns null for an empty list", () => {
    expect(pickPreferredBalance([])).toBeNull();
  });

  it("prefers interim booked, then closing booked, then interim available", () => {
    const interimAvailable = { balanceType: "ITAV", id: 1 };
    const closingBooked = { balanceType: "CLBD", id: 2 };
    const interimBooked = { balanceType: "ITBD", id: 3 };
    expect(pickPreferredBalance([interimAvailable, closingBooked, interimBooked])).toBe(
      interimBooked,
    );
    expect(pickPreferredBalance([interimAvailable, closingBooked])).toBe(closingBooked);
    expect(pickPreferredBalance([interimAvailable])).toBe(interimAvailable);
  });

  it("ranks unknown types after every known one and keeps input order on ties", () => {
    const unknownA = { balanceType: "ZZZZ", id: 1 };
    const unknownB = { balanceType: "YYYY", id: 2 };
    const other = { balanceType: "OTHR", id: 3 };
    expect(pickPreferredBalance([unknownA, other])).toBe(other);
    expect(pickPreferredBalance([unknownA, unknownB])).toBe(unknownA);
  });

  it("lists the known types in the documented order", () => {
    expect([...PREFERRED_BALANCE_TYPES]).toEqual([
      "ITBD",
      "CLBD",
      "ITAV",
      "CLAV",
      "XPCD",
      "OPBD",
      "OPAV",
      "PRCD",
      "FWAV",
      "VALU",
      "INFO",
      "OTHR",
    ]);
  });
});

describe("accountDisplayName", () => {
  const base = {
    nickname: null,
    product: null,
    details: null,
    cashAccountType: "CACC",
    last4: "1234",
  };

  it("prefers nickname, then product, then details", () => {
    expect(
      accountDisplayName({ ...base, nickname: "Rent", product: "Smart", details: "d" }, "en"),
    ).toBe("Rent");
    expect(accountDisplayName({ ...base, product: "Smart", details: "d" }, "en")).toBe("Smart");
    expect(accountDisplayName({ ...base, details: "Main account" }, "en")).toBe("Main account");
  });

  it("ignores blank strings", () => {
    expect(accountDisplayName({ ...base, nickname: "  ", product: "", details: " " }, "en")).toBe(
      "Current account ••1234",
    );
  });

  it("falls back to the localised type label and the last four characters", () => {
    expect(accountDisplayName(base, "it")).toBe("Conto corrente ••1234");
    expect(accountDisplayName({ ...base, cashAccountType: "SVGS" }, "en")).toBe("Savings ••1234");
    expect(accountDisplayName({ ...base, cashAccountType: "CARD", last4: null }, "it")).toBe(
      "Carta",
    );
  });

  it("uses the generic label for a missing or unknown type", () => {
    expect(accountDisplayName({ ...base, cashAccountType: null }, "en")).toBe("Account ••1234");
    expect(accountDisplayName({ ...base, cashAccountType: "constructor" }, "en")).toBe(
      "Account ••1234",
    );
  });

  it("has a label in both languages for every cash account type", () => {
    expect(Object.keys(CASH_ACCOUNT_TYPE_LABELS.it)).toEqual(
      Object.keys(CASH_ACCOUNT_TYPE_LABELS.en),
    );
  });
});

describe("isIncludedInTotals", () => {
  it("counts active and unavailable accounts only", () => {
    expect(isIncludedInTotals("active")).toBe(true);
    expect(isIncludedInTotals("unavailable")).toBe(true);
    expect(isIncludedInTotals("disabled")).toBe(false);
    expect(isIncludedInTotals("removed")).toBe(false);
  });
});
