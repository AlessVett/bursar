import { normalizeForSearch } from "@bursar/shared";
import type { QueryDeps } from "../finance/queries";
import {
  FinanceRepository,
  type NewAccount,
  type NewConnection,
  type NewTransaction,
} from "../finance/repository";
import { JobQueue } from "../jobs/queue";
import type { TestDatabase } from "./db";

/** 2026-11-09 11:00 in Europe/Rome. */
export const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);
export const TODAY = "2026-11-09";
export const TIME_ZONE = "Europe/Rome";
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export function queryDeps(t: TestDatabase, overrides: Partial<QueryDeps> = {}): QueryDeps {
  return {
    db: t.db,
    sqlite: t.sqlite,
    queue: new JobQueue(t.sqlite, () => NOW),
    timezone: TIME_ZONE,
    now: () => NOW,
    locale: () => "en",
    ...overrides,
  };
}

type TransactionOverrides = Partial<NewTransaction> & { sortDate: string; amountMinor: number };

/** Builds finance rows through the repository with fictional data and a fixed clock. */
export class FinanceFixture {
  readonly repo: FinanceRepository;
  private counter = 0;

  constructor(t: TestDatabase) {
    this.repo = new FinanceRepository(t.db, () => NOW);
  }

  connection(overrides: Partial<NewConnection> = {}): number {
    this.counter += 1;
    return this.repo.createConnection({
      aspspName: "Banca Esempio",
      aspspCountry: "IT",
      providerSessionId: `session-${this.counter}`,
      validUntil: NOW + 100 * DAY_MS,
      ...overrides,
    });
  }

  account(connectionId: number, overrides: Partial<NewAccount> = {}): number {
    this.counter += 1;
    return this.repo.createAccount({
      connectionId,
      identificationHash: `hash-${this.counter}`,
      currency: "EUR",
      ...overrides,
    });
  }

  balance(
    accountId: number,
    amountMinor: number,
    options: { type?: string; currency?: string; referenceDate?: string; asOf?: number } = {},
  ): void {
    this.repo.upsertBalance({
      accountId,
      balanceType: options.type ?? "CLBD",
      amountMinor,
      currency: options.currency ?? "EUR",
      referenceDate: options.referenceDate ?? TODAY,
      asOf: options.asOf ?? NOW,
      fetchedAt: NOW,
    });
  }

  transaction(accountId: number, overrides: TransactionOverrides): number {
    this.counter += 1;
    const status = overrides.status ?? "booked";
    const counterparty = overrides.counterparty ?? null;
    const remittance = overrides.remittance ?? null;
    return this.repo.insertTransaction({
      accountId,
      providerReference: null,
      fingerprint: `fp-${this.counter}`,
      status,
      bookingDate: status === "booked" ? overrides.sortDate : null,
      valueDate: null,
      transactionDate: null,
      currency: "EUR",
      counterparty,
      counterpartyAccount: null,
      remittance,
      bankCode: null,
      merchantCategoryCode: null,
      balanceAfterMinor: null,
      searchText: normalizeForSearch(`${counterparty ?? ""} ${remittance ?? ""}`),
      rawJson: "{}",
      missingCount: 0,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      ...overrides,
    });
  }
}

export interface World {
  bankA: number;
  bankB: number;
  removedBank: number;
  checking: number;
  savings: number;
  usd: number;
  disabled: number;
  removed: number;
  transactions: Record<string, number>;
}

/**
 * A small fictional portfolio used by the query and route tests.
 *
 * Counted in the totals (active or unavailable): `checking` and `savings` (EUR, bank A) and `usd`
 * (USD, bank B). Not counted: `disabled` (bank A) and `removed` (a disconnected bank). Preferred
 * balances: checking 500 000, savings 200 000, usd 80 000 (minor units). Transactions of the
 * counted accounts: 7 on `checking`, 1 on `savings`, 2 on `usd`.
 */
export function buildWorld(fx: FinanceFixture): World {
  const bankA = fx.connection({
    aspspName: "Banca Esempio",
    aspspLogoUrl: "https://logos.example.test/banca-esempio.png",
  });
  const bankB = fx.connection({
    aspspName: "Northwind Bank",
    aspspCountry: "GB",
    validUntil: NOW + 9 * DAY_MS,
  });
  const removedBank = fx.connection({
    aspspName: "Old Bank",
    validUntil: NOW + 10 * DAY_MS,
    removedAt: NOW - DAY_MS,
  });

  const checking = fx.account(bankA, {
    iban: "IT60X0542811101000000123456",
    maskedIdentifier: "IT60 •••• •••• 3456",
    last4: "3456",
    product: "Conto Esempio",
    cashAccountType: "CACC",
    lastSyncedAt: NOW - 3 * HOUR_MS,
  });
  const savings = fx.account(bankA, {
    iban: "IT28W8000000292100645349012",
    maskedIdentifier: "IT28 •••• •••• 9012",
    last4: "9012",
    nickname: "Rainy day",
    cashAccountType: "SVGS",
  });
  const usd = fx.account(bankB, {
    currency: "USD",
    maskedIdentifier: "•••• 4821",
    last4: "4821",
    product: "Dollar Account",
    cashAccountType: "CACC",
  });
  const disabled = fx.account(bankA, {
    status: "disabled",
    last4: "7777",
    maskedIdentifier: "•••• 7777",
    product: "Old card",
    cashAccountType: "CARD",
  });
  const removed = fx.account(removedBank, {
    status: "removed",
    removedAt: NOW - DAY_MS,
    last4: "5555",
    maskedIdentifier: "•••• 5555",
    product: "Closed account",
  });

  fx.balance(checking, 500_000);
  fx.balance(savings, 200_000);
  fx.balance(usd, 80_000, { currency: "USD" });

  const transactions: Record<string, number> = {
    salary: fx.transaction(checking, {
      sortDate: "2026-11-09",
      amountMinor: 250_000,
      counterparty: "Acme Payroll",
      remittance: "Salary November",
      providerReference: "REF-SALARY",
      rawJson: JSON.stringify({
        entry_reference: "REF-SALARY",
        remittance_information: ["Salary November", " Rif. 2026/11 ", ""],
        bank_transaction_code: { code: "RCDT", description: "Credit transfer" },
      }),
      bankCode: { code: "RCDT", subCode: "ESCT", description: "Credit transfer" },
      counterpartyAccount: "DE89 •••• •••• 3000",
      merchantCategoryCode: "5411",
      balanceAfterMinor: 500_000,
      valueDate: "2026-11-09",
      transactionDate: "2026-11-08",
    }),
    coffee: fx.transaction(checking, {
      sortDate: "2026-11-08",
      amountMinor: -1_250,
      counterparty: "Caffè Roma",
      remittance: "Coffee",
    }),
    groceries: fx.transaction(checking, {
      sortDate: "2026-11-07",
      amountMinor: -8_450,
      counterparty: "Supermercato Verde",
      remittance: "Groceries",
    }),
    pendingCoffee: fx.transaction(checking, {
      sortDate: "2026-11-05",
      amountMinor: -1_250,
      status: "pending",
      counterparty: "Caffè Roma",
      remittance: "Coffee",
    }),
    rent: fx.transaction(checking, {
      sortDate: "2026-10-15",
      amountMinor: -12_000,
      counterparty: "Landlord",
      remittance: "Rent 100% paid_in_full",
    }),
    bakery: fx.transaction(checking, {
      sortDate: "2026-10-11",
      amountMinor: -500,
      counterparty: "Bakery Rossi",
      remittance: "Bread",
    }),
    old: fx.transaction(checking, {
      sortDate: "2026-10-10",
      amountMinor: -700,
      counterparty: "Old Tx Srl",
      remittance: "Outside the window",
    }),
    saving: fx.transaction(savings, {
      sortDate: "2026-11-01",
      amountMinor: 10_000,
      counterparty: "Transfer in",
      remittance: "Monthly saving",
    }),
    usdCoffee: fx.transaction(usd, {
      sortDate: "2026-11-03",
      amountMinor: -2_000,
      currency: "USD",
      counterparty: "Coffee Corp",
      remittance: "Latte",
    }),
    usdInvoice: fx.transaction(usd, {
      sortDate: "2026-11-04",
      amountMinor: 50_000,
      currency: "USD",
      counterparty: "Client Inc",
      remittance: "Invoice 12",
    }),
    disabledShop: fx.transaction(disabled, {
      sortDate: "2026-11-06",
      amountMinor: -999,
      counterparty: "Disabled Shop",
      remittance: "Hidden",
    }),
    removedShop: fx.transaction(removed, {
      sortDate: "2026-11-02",
      amountMinor: -3_000,
      counterparty: "Closed Shop",
      remittance: "Kept until purge",
    }),
  };

  return { bankA, bankB, removedBank, checking, savings, usd, disabled, removed, transactions };
}
