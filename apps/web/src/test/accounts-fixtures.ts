import type { AccountSummary, ConnectionSummary, RemovedAccountSummary } from "@bursar/shared";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** 2026-11-09 11:00 in Europe/Rome (no DST change within the following three weeks). */
export const FIXED_NOW = Date.UTC(2026, 10, 9, 10, 0, 0);

export function accountFixture(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: 1,
    connectionId: 1,
    name: "Conto Esempio",
    nickname: null,
    bankProduct: "Conto Esempio",
    maskedIdentifier: "IT60 •••• •••• 3456",
    iban: "IT60X0542811101000000123456",
    last4: "3456",
    currency: "EUR",
    cashAccountType: "CACC",
    status: "active",
    balance: { amountMinor: 123_450, currency: "EUR", type: "ITBD", asOf: FIXED_NOW - 3 * HOUR },
    net30d: { inMinor: 300_000, outMinor: 253_000, netMinor: 47_000 },
    daily30d: [],
    lastSyncedAt: FIXED_NOW - 3 * HOUR,
    lastSyncError: null,
    rateLimitedUntil: null,
    syncInProgress: false,
    ...overrides,
  };
}

export function connectionFixture(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 1,
    bankName: "Northwind Bank",
    country: "IT",
    hasLogo: false,
    status: "active",
    validUntil: FIXED_NOW + 60 * DAY,
    createdAt: FIXED_NOW - 90 * DAY,
    renewedAt: null,
    lastError: null,
    accounts: [accountFixture()],
    ...overrides,
  };
}

export function removedFixture(
  overrides: Partial<RemovedAccountSummary> = {},
): RemovedAccountSummary {
  return {
    id: 9,
    name: "Old savings",
    maskedIdentifier: "IT60 •••• •••• 7890",
    bankName: "Northwind Bank",
    transactionCount: 1234,
    removedAt: FIXED_NOW - 2 * DAY,
    ...overrides,
  };
}
