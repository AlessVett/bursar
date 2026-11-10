import { createHash } from "node:crypto";
import {
  accountDisplayName,
  addDays,
  identifierLast4,
  type LocalDate,
  maskIban,
  maskIdentifier,
  minorToDecimalString,
  normalizeForSearch,
  startOfLocalDay,
  toLocalDate,
} from "@bursar/shared";
import { backupRuns, notifications } from "../db/schema";
import {
  type BankTransactionCode,
  FinanceRepository,
  type NewAccount,
  type NewConnection,
} from "../finance/repository";
import type { SeedContext } from "../server";

/**
 * Deterministic, fictional banking data for the QA harness and local demos: every connection and
 * account state, mixed currencies, pending transactions, failed and skipped syncs, notifications
 * and a backup run. Nothing here comes from a real bank: names are invented, IBANs are generated
 * with valid check digits on unassigned bank codes, and all dates are relative to `ctx.now()`.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Small seeded PRNG (mulberry32): the same seed always yields the same sequence. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function ibanCheckDigits(country: string, bban: string): string {
  let remainder = 0;
  for (const char of `${bban}${country}00`) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return String(98 - remainder).padStart(2, "0");
}

function makeIban(country: string, bban: string): string {
  return `${country}${ibanCheckDigits(country, bban)}${bban}`;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface RecurringSpec {
  dayOfMonth: number;
  amountMinor: number;
  counterparty: string;
  lines: string[];
  counterpartyAccount?: string;
  bankCode?: BankTransactionCode;
  mcc?: string;
  card?: boolean;
}

interface PoolSpec {
  probability: number;
  minMinor: number;
  maxMinor: number;
  direction: 1 | -1;
  counterparties: readonly string[];
  lines: string[];
  mcc: string | null;
  card: boolean;
}

interface FixedSpec {
  daysAgo: number;
  amountMinor: number;
  counterparty: string | null;
  lines?: string[];
  mcc?: string;
  card?: boolean;
  pending?: boolean;
}

interface LedgerSpec {
  /** Recurring and pooled transactions are generated for each day from `fromDaysAgo` down to `toDaysAgo`. */
  fromDaysAgo?: number;
  toDaysAgo?: number;
  recurring?: RecurringSpec[];
  pools?: PoolSpec[];
  fixed?: FixedSpec[];
}

interface Entry {
  date: LocalDate;
  pending: boolean;
  amountMinor: number;
  counterparty: string | null;
  counterpartyAccount: string | null;
  lines: string[];
  mcc: string | null;
  bankCode: BankTransactionCode | null;
  card: boolean;
}

const SEPA_CREDIT: BankTransactionCode = {
  code: "RCDT",
  subCode: "ESCT",
  description: "SEPA credit transfer received",
};

const GROCERIES: PoolSpec = {
  probability: 0.35,
  minMinor: 800,
  maxMinor: 9_500,
  direction: -1,
  counterparties: ["Supermercato Centrale", "Mercato Rionale", "Alimentari Sole"],
  lines: ["Acquisto con carta"],
  mcc: "5411",
  card: true,
};

const CAFES: PoolSpec = {
  probability: 0.28,
  minMinor: 350,
  maxMinor: 6_500,
  direction: -1,
  counterparties: ["Caffè Centrale", "Trattoria Il Porto", "Pizzeria Margherita", "Bar Stazione"],
  lines: ["Acquisto con carta"],
  mcc: "5812",
  card: true,
};

const TRANSPORT: PoolSpec = {
  probability: 0.15,
  minMinor: 150,
  maxMinor: 2_800,
  direction: -1,
  counterparties: ["Trasporti Urbani", "Taxi Città", "Parcheggio Centro"],
  lines: ["Acquisto con carta"],
  mcc: "4111",
  card: true,
};

export function seedBanking(ctx: SeedContext): void {
  const now = ctx.now();
  const timeZone = ctx.config.timezone;
  const today = toLocalDate(now, timeZone);
  const rng = mulberry32(20_261_109);
  const repo = new FinanceRepository(ctx.db, ctx.now);

  const ago = (ms: number): number => now - ms;
  /** About noon of the local day `days` from today: stays on that calendar day across DST. */
  const localNoon = (days: number): number =>
    startOfLocalDay(addDays(today, days), timeZone) + 12 * HOUR;
  const intBetween = (min: number, max: number): number =>
    min + Math.floor(rng() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

  function buildEntries(spec: LedgerSpec): Entry[] {
    const entries: Entry[] = [];
    const first = spec.fromDaysAgo ?? -1;
    const last = spec.toDaysAgo ?? 0;
    for (let daysAgo = first; daysAgo >= last; daysAgo--) {
      const date = addDays(today, -daysAgo);
      const dayOfMonth = Number(date.slice(8, 10));
      for (const item of spec.recurring ?? []) {
        if (item.dayOfMonth !== dayOfMonth) continue;
        entries.push({
          date,
          pending: false,
          amountMinor: item.amountMinor,
          counterparty: item.counterparty,
          counterpartyAccount: item.counterpartyAccount ?? null,
          lines: item.lines,
          mcc: item.mcc ?? null,
          bankCode: item.bankCode ?? null,
          card: item.card ?? false,
        });
      }
      for (const pool of spec.pools ?? []) {
        if (rng() >= pool.probability) continue;
        entries.push({
          date,
          pending: false,
          amountMinor: pool.direction * intBetween(pool.minMinor, pool.maxMinor),
          counterparty: pick(pool.counterparties),
          counterpartyAccount: null,
          lines: pool.lines,
          mcc: pool.mcc,
          bankCode: null,
          card: pool.card,
        });
      }
    }
    for (const item of spec.fixed ?? []) {
      entries.push({
        date: addDays(today, -item.daysAgo),
        pending: item.pending ?? false,
        amountMinor: item.amountMinor,
        counterparty: item.counterparty,
        counterpartyAccount: null,
        lines: item.lines ?? [],
        mcc: item.mcc ?? null,
        bankCode: null,
        card: item.card ?? false,
      });
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Inserts the entries oldest first; returns the net of the booked ones. */
  function insertLedger(
    accountId: number,
    currency: string,
    entries: readonly Entry[],
    lastSeenAt: number,
    openingMinor: number | null,
  ): number {
    let running = openingMinor;
    let net = 0;
    entries.forEach((entry, index) => {
      const bookingDate = entry.pending ? null : entry.date;
      const transactionDate = entry.card
        ? entry.pending
          ? entry.date
          : addDays(entry.date, -1)
        : null;
      const reference = `E${accountId}${String(index + 1).padStart(6, "0")}`;
      const providerReference = entry.pending || rng() >= 0.8 ? null : reference;
      if (!entry.pending) {
        net += entry.amountMinor;
        if (running !== null) running += entry.amountMinor;
      }
      const remittance = entry.lines.length > 0 ? entry.lines.join(" ") : null;
      const firstSeenAt = Math.min(
        lastSeenAt,
        startOfLocalDay(entry.date, timeZone) + 7 * HOUR + intBetween(0, 3 * HOUR),
      );
      repo.insertTransaction({
        accountId,
        providerReference,
        fingerprint: sha256(
          [accountId, index, entry.date, entry.amountMinor, entry.counterparty ?? ""].join("|"),
        ),
        status: entry.pending ? "pending" : "booked",
        bookingDate,
        valueDate: bookingDate,
        transactionDate,
        sortDate: bookingDate ?? transactionDate ?? entry.date,
        amountMinor: entry.amountMinor,
        currency,
        counterparty: entry.counterparty,
        counterpartyAccount: entry.counterpartyAccount,
        remittance,
        bankCode: entry.bankCode,
        merchantCategoryCode: entry.mcc,
        balanceAfterMinor: entry.pending ? null : running,
        searchText: normalizeForSearch([entry.counterparty, remittance].filter(Boolean).join(" ")),
        rawJson: JSON.stringify({
          entry_reference: providerReference,
          transaction_amount: {
            currency,
            amount: minorToDecimalString(Math.abs(entry.amountMinor), currency),
          },
          credit_debit_indicator: entry.amountMinor < 0 ? "DBIT" : "CRDT",
          status: entry.pending ? "PDNG" : "BOOK",
          booking_date: bookingDate,
          value_date: bookingDate,
          transaction_date: transactionDate,
          remittance_information: entry.lines,
          [entry.amountMinor < 0 ? "creditor" : "debtor"]: entry.counterparty
            ? { name: entry.counterparty }
            : null,
          bank_transaction_code: entry.bankCode
            ? {
                code: entry.bankCode.code,
                sub_code: entry.bankCode.subCode,
                description: entry.bankCode.description,
              }
            : undefined,
          merchant_category_code: entry.mcc,
        }),
        missingCount: 0,
        firstSeenAt,
        lastSeenAt,
      });
    });
    return net;
  }

  function addBalance(
    accountId: number,
    balanceType: string,
    amountMinor: number,
    currency: string,
    referenceDate: LocalDate,
    asOf: number,
    fetchedAt: number,
  ): void {
    repo.upsertBalance({
      accountId,
      balanceType,
      amountMinor,
      currency,
      referenceDate,
      asOf,
      fetchedAt,
    });
  }

  function addRun(
    accountId: number,
    agoMs: number,
    trigger: "initial" | "manual" | "background" | "renewal",
    outcome:
      | {
          status: "succeeded";
          fetched: number;
          inserted: number;
          updated?: number;
          removed?: number;
        }
      | { status: "failed"; errorCode: string; errorMessage: string }
      | {
          status: "skipped";
          skipReason:
            | "rate_limited"
            | "daily_cap"
            | "connection_inactive"
            | "account_inactive"
            | "no_provider_uid";
        },
    withPsuHeaders = false,
  ): void {
    const startedAt = ago(agoMs);
    const finishedAt = startedAt + intBetween(3_000, 40_000);
    const id = repo.startSyncRun({ accountId, trigger, withPsuHeaders, startedAt });
    if (outcome.status === "succeeded") {
      repo.finishSyncRun(id, {
        status: "succeeded",
        finishedAt,
        fetched: outcome.fetched,
        inserted: outcome.inserted,
        updated: outcome.updated ?? 0,
        removed: outcome.removed ?? 0,
      });
    } else if (outcome.status === "failed") {
      repo.finishSyncRun(id, {
        status: "failed",
        finishedAt,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
      });
    } else {
      repo.finishSyncRun(id, {
        status: "skipped",
        finishedAt: startedAt,
        skipReason: outcome.skipReason,
      });
    }
  }

  repo.transaction(() => {
    // Fictional counterparties' accounts, shown masked on transfers.
    const salaryIban = makeIban("IT", "X9999999999000000770001");
    const landlordIban = makeIban("IT", "X9999999999000000770002");
    const employerDeIban = makeIban("DE", "99999999" + "0000770003");
    const landlordDeIban = makeIban("DE", "99999999" + "0000770004");

    // Connections -------------------------------------------------------------------------

    const connection = (
      n: number,
      aspspName: string,
      aspspCountry: string,
      createdDaysAgo: number,
      validUntil: number,
      extra: Partial<NewConnection> = {},
    ): number =>
      repo.createConnection({
        aspspName,
        aspspCountry,
        providerSessionId: uuidFor(900 + n),
        validUntil,
        statusCheckedAt: ago(6 * HOUR),
        createdAt: ago(createdDaysAgo * DAY),
        updatedAt: ago(6 * HOUR),
        ...extra,
      });

    const bancaEsempio = connection(1, "Banca Esempio", "IT", 125, localNoon(88));
    const northwind = connection(2, "Northwind Bank", "DE", 171, localNoon(9));
    const orizzonte = connection(3, "Banca Orizzonte", "IT", 175, localNoon(-5), {
      status: "expired",
      lastErrorCode: "EXPIRED_SESSION",
      lastErrorMessage: "The consent has expired and needs to be renewed",
      lastErrorAt: ago(100 * HOUR),
    });
    const credito = connection(4, "Credito Fittizio", "IT", 60, localNoon(120), {
      status: "revoked",
      lastErrorCode: "REVOKED_SESSION",
      lastErrorMessage: "The consent was withdrawn at the bank",
      lastErrorAt: ago(12 * DAY),
    });
    const polaris = connection(5, "Polaris Finance", "FR", 40, localNoon(140), {
      status: "error",
      lastErrorCode: "ACCESS_DENIED",
      lastErrorMessage: "The bank refused access to the account data",
      lastErrorAt: ago(10 * HOUR),
    });
    const disconnected = connection(6, "Banca Esempio", "IT", 110, localNoon(70), {
      status: "revoked",
      removedAt: ago(20 * DAY),
      updatedAt: ago(20 * DAY),
    });

    // Accounts ----------------------------------------------------------------------------

    const account = (
      n: number,
      connectionId: number,
      identifier: { iban: string } | { other: string },
      fields: Partial<NewAccount> = {},
    ): number => {
      const iban = "iban" in identifier ? identifier.iban : null;
      const raw = "iban" in identifier ? identifier.iban : identifier.other;
      return repo.createAccount({
        connectionId,
        identificationHash: sha256(`bursar-seed:${raw}`),
        currency: "EUR",
        iban,
        maskedIdentifier: iban ? maskIban(iban) : maskIdentifier(raw),
        last4: identifierLast4(raw),
        providerAccountUid: uuidFor(n),
        cashAccountType: "CACC",
        createdAt: repo.getConnection(connectionId)?.createdAt ?? ago(DAY),
        ...fields,
      });
    };

    const current = account(
      1,
      bancaEsempio,
      { iban: makeIban("IT", "X9999999999000000010001") },
      {
        product: "Conto Smart",
        details: "Conto corrente consumer",
        lastSyncedAt: ago(2 * HOUR),
        bgFetchDay: today,
        bgFetchCount: 1,
        lastScheduledSyncDay: today,
      },
    );
    const savings = account(
      2,
      bancaEsempio,
      { iban: makeIban("IT", "X9999999999000000010002") },
      {
        nickname: "Fondo emergenza",
        product: "Conto Deposito",
        cashAccountType: "SVGS",
        lastSyncedAt: ago(2 * HOUR),
        bgFetchDay: today,
        bgFetchCount: 1,
        lastScheduledSyncDay: today,
      },
    );
    const giro = account(
      3,
      northwind,
      { iban: makeIban("DE", "99999999" + "0000020001") },
      {
        product: "Girokonto Plus",
        lastSyncedAt: ago(9 * HOUR),
        rateLimitedUntil: now + HOUR,
        lastSyncErrorCode: "ASPSP_RATE_LIMIT_EXCEEDED",
        lastSyncErrorAt: ago(5 * HOUR),
        bgFetchDay: today,
        bgFetchCount: 2,
        lastScheduledSyncDay: today,
      },
    );
    const dollar = account(
      4,
      northwind,
      { other: "000048214821" },
      {
        currency: "USD",
        product: "Dollar Account",
        lastSyncedAt: ago(6 * HOUR),
        bgFetchDay: today,
        bgFetchCount: 2,
        lastScheduledSyncDay: today,
      },
    );
    const prepaid = account(
      5,
      northwind,
      { iban: makeIban("DE", "99999999" + "0000020005") },
      {
        providerAccountUid: null,
        product: "Prepaid Card",
        cashAccountType: "CARD",
        status: "unavailable",
        lastSyncedAt: ago(6 * DAY),
      },
    );
    const stale = account(
      6,
      orizzonte,
      { iban: makeIban("IT", "X9999999999000000030001") },
      {
        product: "Conto Libero",
        lastSyncedAt: ago(104 * HOUR),
        lastSyncErrorCode: "EXPIRED_SESSION",
        lastSyncErrorAt: ago(100 * HOUR),
      },
    );
    const card = account(
      7,
      orizzonte,
      { iban: makeIban("IT", "X9999999999000000030002") },
      {
        product: "Carta Credito Classic",
        cashAccountType: "CARD",
        status: "disabled",
        lastSyncedAt: ago(20 * DAY),
      },
    );
    const mortgage = account(
      8,
      credito,
      { iban: makeIban("IT", "X9999999999000000040001") },
      {
        product: "Mutuo Casa",
        cashAccountType: "LOAN",
        lastSyncedAt: ago(30 * DAY),
        lastSyncErrorCode: "REVOKED_SESSION",
        lastSyncErrorAt: ago(12 * DAY),
      },
    );
    const failing = account(
      9,
      polaris,
      { iban: makeIban("FR", "9999999999" + "00000000501" + "00") },
      {
        product: "Compte Courant",
        lastSyncedAt: ago(31 * HOUR),
        lastSyncErrorCode: "ACCESS_DENIED",
        lastSyncErrorAt: ago(10 * HOUR),
      },
    );
    const removed = account(
      10,
      disconnected,
      { iban: makeIban("IT", "X9999999999000000060001") },
      {
        product: "Conto Smart",
        status: "removed",
        removedAt: ago(20 * DAY),
        lastSyncedAt: ago(21 * DAY),
        updatedAt: ago(20 * DAY),
      },
    );

    // Transactions and balances -----------------------------------------------------------

    const currentSynced = ago(2 * HOUR);
    const currentEntries = buildEntries({
      fromDaysAgo: 119,
      toDaysAgo: 2,
      recurring: [
        {
          dayOfMonth: 27,
          amountMinor: 245_000,
          counterparty: "Orbit Labs S.r.l.",
          lines: ["Stipendio", "Rif. EMP-2026"],
          counterpartyAccount: maskIban(salaryIban),
          bankCode: SEPA_CREDIT,
        },
        {
          dayOfMonth: 1,
          amountMinor: -75_000,
          counterparty: "Immobiliare Esempio S.r.l.",
          lines: ["Canone locazione", "Rif. AF-1042"],
          counterpartyAccount: maskIban(landlordIban),
        },
        {
          dayOfMonth: 12,
          amountMinor: -6_840,
          counterparty: "Energia Verde S.p.A.",
          lines: ["Fattura energia elettrica"],
        },
        {
          dayOfMonth: 18,
          amountMinor: -2_990,
          counterparty: "Fibra Casa",
          lines: ["Abbonamento fibra"],
        },
        {
          dayOfMonth: 5,
          amountMinor: -1_299,
          counterparty: "Streamly",
          lines: ["Abbonamento mensile"],
          mcc: "4899",
          card: true,
        },
        {
          dayOfMonth: 3,
          amountMinor: -3_500,
          counterparty: "Palestra Fitness Club",
          lines: ["Quota mensile"],
          mcc: "7997",
          card: true,
        },
        {
          dayOfMonth: 21,
          amountMinor: -299,
          counterparty: "Cloudbox",
          lines: ["Archiviazione cloud"],
          mcc: "5734",
          card: true,
        },
      ],
      pools: [
        GROCERIES,
        CAFES,
        TRANSPORT,
        {
          probability: 0.04,
          minMinor: 3_500,
          maxMinor: 7_500,
          direction: -1,
          counterparties: ["Distributore Nord"],
          lines: ["Rifornimento carburante"],
          mcc: "5541",
          card: true,
        },
        {
          probability: 0.04,
          minMinor: 500,
          maxMinor: 4_500,
          direction: -1,
          counterparties: ["Farmacia Comunale"],
          lines: ["Acquisto con carta"],
          mcc: "5912",
          card: true,
        },
        {
          probability: 0.05,
          minMinor: 1_500,
          maxMinor: 15_000,
          direction: -1,
          counterparties: [
            "Negozio Elettronica Tech",
            "Libreria Pagina Uno",
            "Abbigliamento Moda Viva",
          ],
          lines: ["Acquisto con carta"],
          mcc: "5311",
          card: true,
        },
        {
          probability: 0.03,
          minMinor: 2_000,
          maxMinor: 8_000,
          direction: 1,
          counterparties: ["Rimborso spese"],
          lines: ["Rimborso"],
          mcc: null,
          card: false,
        },
      ],
      fixed: [
        {
          daysAgo: 1,
          amountMinor: -4_250,
          counterparty: "Trattoria Il Porto",
          lines: ["Acquisto con carta"],
          mcc: "5812",
          card: true,
          pending: true,
        },
        {
          daysAgo: 0,
          amountMinor: -1_850,
          counterparty: "Supermercato Centrale",
          lines: ["Acquisto con carta"],
          mcc: "5411",
          card: true,
          pending: true,
        },
        {
          daysAgo: 0,
          amountMinor: -62_000,
          counterparty: null,
          lines: ["Prenotazione hotel Esempio"],
          mcc: "7011",
          card: true,
          pending: true,
        },
      ],
    });
    const currentFinal = 428_015;
    const currentBookedNet = currentEntries
      .filter((entry) => !entry.pending)
      .reduce((sum, entry) => sum + entry.amountMinor, 0);
    const currentOpening = currentFinal - currentBookedNet;
    insertLedger(current, "EUR", currentEntries, currentSynced, currentOpening);
    {
      // One closing booked balance per day, rebuilt from the same ledger.
      let closing = currentOpening;
      for (let daysAgo = 119; daysAgo >= 0; daysAgo--) {
        const date = addDays(today, -daysAgo);
        for (const entry of currentEntries) {
          if (!entry.pending && entry.date === date) closing += entry.amountMinor;
        }
        const endOfDay = startOfLocalDay(addDays(date, 1), timeZone) - 1_000;
        const asOf = daysAgo === 0 ? currentSynced : endOfDay;
        addBalance(current, "CLBD", closing, "EUR", date, asOf, asOf);
      }
      const pendingTotal = currentEntries
        .filter((entry) => entry.pending)
        .reduce((sum, entry) => sum + entry.amountMinor, 0);
      addBalance(
        current,
        "ITAV",
        currentFinal + pendingTotal,
        "EUR",
        today,
        currentSynced,
        currentSynced,
      );
    }

    insertLedger(
      savings,
      "EUR",
      buildEntries({
        fromDaysAgo: 119,
        toDaysAgo: 2,
        recurring: [
          {
            dayOfMonth: 28,
            amountMinor: 20_000,
            counterparty: "Giroconto da conto corrente",
            lines: ["Giroconto mensile"],
            bankCode: SEPA_CREDIT,
          },
          {
            dayOfMonth: 15,
            amountMinor: 1_840,
            counterparty: "Banca Esempio",
            lines: ["Interessi netti"],
          },
        ],
      }),
      currentSynced,
      null,
    );
    addBalance(savings, "ITBD", 1_250_000, "EUR", today, currentSynced, currentSynced);

    const giroSynced = ago(9 * HOUR);
    insertLedger(
      giro,
      "EUR",
      buildEntries({
        fromDaysAgo: 60,
        toDaysAgo: 2,
        recurring: [
          {
            dayOfMonth: 25,
            amountMinor: 310_000,
            counterparty: "Nordlicht GmbH",
            lines: ["Gehalt"],
            counterpartyAccount: maskIban(employerDeIban),
            bankCode: SEPA_CREDIT,
          },
          {
            dayOfMonth: 3,
            amountMinor: -68_000,
            counterparty: "Hausverwaltung Nord",
            lines: ["Miete"],
            counterpartyAccount: maskIban(landlordDeIban),
          },
        ],
        pools: [
          {
            probability: 0.3,
            minMinor: 400,
            maxMinor: 7_800,
            direction: -1,
            counterparties: ["Bäckerei Sonnenschein", "Markt Frisch", "Kaufhalle Mitte"],
            lines: ["Kartenzahlung"],
            mcc: "5411",
            card: true,
          },
          {
            probability: 0.2,
            minMinor: 300,
            maxMinor: 4_200,
            direction: -1,
            counterparties: ["Café Zentral", "Brauhaus Am Fluss"],
            lines: ["Kartenzahlung"],
            mcc: "5812",
            card: true,
          },
          {
            probability: 0.15,
            minMinor: 280,
            maxMinor: 3_900,
            direction: -1,
            counterparties: ["Verkehrsbetriebe"],
            lines: ["Kartenzahlung"],
            mcc: "4111",
            card: true,
          },
        ],
        fixed: [
          {
            daysAgo: 0,
            amountMinor: -2_380,
            counterparty: "Café Zentral",
            lines: ["Kartenzahlung"],
            mcc: "5812",
            card: true,
            pending: true,
          },
        ],
      }),
      giroSynced,
      null,
    );
    addBalance(giro, "ITBD", 196_842, "EUR", today, giroSynced, giroSynced);

    const dollarSynced = ago(6 * HOUR);
    insertLedger(
      dollar,
      "USD",
      buildEntries({
        fromDaysAgo: 45,
        toDaysAgo: 2,
        recurring: [
          {
            dayOfMonth: 20,
            amountMinor: 120_000,
            counterparty: "Freelance Client Ltd",
            lines: ["Invoice payment"],
          },
          {
            dayOfMonth: 10,
            amountMinor: -1_999,
            counterparty: "Streaming Plus Inc",
            lines: ["Monthly subscription"],
            mcc: "4899",
            card: true,
          },
          {
            dayOfMonth: 14,
            amountMinor: -4_900,
            counterparty: "Cloud Hosting Inc",
            lines: ["Hosting plan"],
            mcc: "7372",
            card: true,
          },
        ],
        pools: [
          {
            probability: 0.2,
            minMinor: 400,
            maxMinor: 900,
            direction: -1,
            counterparties: ["Coffee Roasters"],
            lines: ["Card purchase"],
            mcc: "5814",
            card: true,
          },
          {
            probability: 0.08,
            minMinor: 2_000,
            maxMinor: 12_000,
            direction: -1,
            counterparties: ["Online Marketplace"],
            lines: ["Card purchase"],
            mcc: "5311",
            card: true,
          },
        ],
        fixed: [
          {
            daysAgo: 1,
            amountMinor: -3_450,
            counterparty: "Online Marketplace",
            lines: ["Card purchase"],
            mcc: "5311",
            card: true,
            pending: true,
          },
        ],
      }),
      dollarSynced,
      null,
    );
    addBalance(dollar, "ITAV", 321_580, "USD", today, dollarSynced, dollarSynced);

    insertLedger(
      prepaid,
      "EUR",
      buildEntries({
        fixed: [
          { daysAgo: 14, amountMinor: 5_000, counterparty: "Ricarica carta", lines: ["Ricarica"] },
          {
            daysAgo: 9,
            amountMinor: -1_890,
            counterparty: "Caffè Centrale",
            lines: ["Acquisto con carta"],
            mcc: "5812",
            card: true,
          },
          {
            daysAgo: 7,
            amountMinor: -2_775,
            counterparty: "Libreria Pagina Uno",
            lines: ["Acquisto con carta"],
            mcc: "5942",
            card: true,
          },
        ],
      }),
      ago(6 * DAY),
      null,
    );
    addBalance(prepaid, "CLBD", 8_735, "EUR", addDays(today, -6), ago(6 * DAY), ago(6 * DAY));

    const staleSynced = ago(104 * HOUR);
    insertLedger(
      stale,
      "EUR",
      buildEntries({
        fromDaysAgo: 60,
        toDaysAgo: 5,
        recurring: [
          {
            dayOfMonth: 27,
            amountMinor: 180_000,
            counterparty: "Studio Associato Esempio",
            lines: ["Compenso"],
            counterpartyAccount: maskIban(salaryIban),
            bankCode: SEPA_CREDIT,
          },
        ],
        pools: [GROCERIES, CAFES],
      }),
      staleSynced,
      null,
    );
    addBalance(
      stale,
      "CLBD",
      61_208,
      "EUR",
      toLocalDate(staleSynced, timeZone),
      staleSynced,
      staleSynced,
    );

    const cardSynced = ago(20 * DAY);
    insertLedger(
      card,
      "EUR",
      buildEntries({
        fixed: [
          {
            daysAgo: 38,
            amountMinor: -8_900,
            counterparty: "Negozio Elettronica Tech",
            lines: ["Acquisto con carta"],
            mcc: "5732",
            card: true,
          },
          {
            daysAgo: 33,
            amountMinor: -4_120,
            counterparty: "Ristorante Il Faro",
            lines: ["Acquisto con carta"],
            mcc: "5812",
            card: true,
          },
          {
            daysAgo: 29,
            amountMinor: -12_500,
            counterparty: "Abbigliamento Moda Viva",
            lines: ["Acquisto con carta"],
            mcc: "5651",
            card: true,
          },
          {
            daysAgo: 26,
            amountMinor: -3_250,
            counterparty: "Distributore Nord",
            lines: ["Rifornimento carburante"],
            mcc: "5541",
            card: true,
          },
          {
            daysAgo: 24,
            amountMinor: -1_790,
            counterparty: "Streamly",
            lines: ["Abbonamento mensile"],
            mcc: "4899",
            card: true,
          },
          {
            daysAgo: 22,
            amountMinor: -9_650,
            counterparty: "Agenzia Viaggi Orizzonte",
            lines: ["Acquisto con carta"],
            mcc: "4722",
            card: true,
          },
        ],
      }),
      cardSynced,
      null,
    );
    addBalance(
      card,
      "CLBD",
      -24_510,
      "EUR",
      toLocalDate(cardSynced, timeZone),
      cardSynced,
      cardSynced,
    );

    const mortgageSynced = ago(30 * DAY);
    insertLedger(
      mortgage,
      "EUR",
      buildEntries({
        fromDaysAgo: 125,
        toDaysAgo: 31,
        recurring: [
          {
            dayOfMonth: 5,
            amountMinor: -118_465,
            counterparty: "Credito Fittizio",
            lines: ["Rata mutuo"],
          },
        ],
      }),
      mortgageSynced,
      null,
    );
    addBalance(
      mortgage,
      "CLBD",
      -8_432_045,
      "EUR",
      toLocalDate(mortgageSynced, timeZone),
      mortgageSynced,
      mortgageSynced,
    );

    const failingSynced = ago(31 * HOUR);
    insertLedger(
      failing,
      "EUR",
      buildEntries({
        fromDaysAgo: 40,
        toDaysAgo: 2,
        recurring: [
          {
            dayOfMonth: 10,
            amountMinor: 150_000,
            counterparty: "Atelier Lumière SARL",
            lines: ["Salaire"],
            bankCode: SEPA_CREDIT,
          },
        ],
        pools: [
          {
            ...GROCERIES,
            counterparties: ["Marché du Centre", "Boulangerie Dupain"],
            lines: ["Paiement par carte"],
          },
        ],
      }),
      failingSynced,
      null,
    );
    addBalance(
      failing,
      "ITBD",
      102_000,
      "EUR",
      toLocalDate(failingSynced, timeZone),
      failingSynced,
      failingSynced,
    );

    const removedSynced = ago(21 * DAY);
    insertLedger(
      removed,
      "EUR",
      buildEntries({
        fromDaysAgo: 90,
        toDaysAgo: 22,
        recurring: [
          {
            dayOfMonth: 27,
            amountMinor: 245_000,
            counterparty: "Orbit Labs S.r.l.",
            lines: ["Stipendio"],
            counterpartyAccount: maskIban(salaryIban),
            bankCode: SEPA_CREDIT,
          },
        ],
        pools: [GROCERIES],
      }),
      removedSynced,
      null,
    );
    addBalance(
      removed,
      "CLBD",
      4_012,
      "EUR",
      toLocalDate(removedSynced, timeZone),
      removedSynced,
      removedSynced,
    );

    // Sync runs ---------------------------------------------------------------------------

    const totalOf = (accountId: number): number => repo.countTransactions(accountId).total;
    const initialCount = Math.max(totalOf(current) - 3, 0);
    addRun(current, 119 * DAY, "initial", {
      status: "succeeded",
      fetched: initialCount,
      inserted: initialCount,
    });
    addRun(current, 3 * DAY, "background", {
      status: "succeeded",
      fetched: 12,
      inserted: 4,
      updated: 1,
    });
    addRun(current, 1 * DAY, "manual", { status: "succeeded", fetched: 9, inserted: 3 }, true);
    addRun(current, 2 * HOUR, "background", {
      status: "succeeded",
      fetched: 8,
      inserted: 1,
      updated: 2,
    });

    addRun(savings, 119 * DAY, "initial", { status: "succeeded", fetched: 8, inserted: 8 });
    addRun(savings, 2 * HOUR, "background", { status: "succeeded", fetched: 2, inserted: 0 });

    addRun(giro, 59 * DAY, "initial", {
      status: "succeeded",
      fetched: totalOf(giro),
      inserted: totalOf(giro),
    });
    addRun(giro, 9 * HOUR, "background", { status: "succeeded", fetched: 6, inserted: 2 });
    addRun(giro, 5 * HOUR, "background", {
      status: "failed",
      errorCode: "ASPSP_RATE_LIMIT_EXCEEDED",
      errorMessage: "The bank is limiting how often the account can be fetched",
    });
    addRun(giro, 1 * HOUR, "background", { status: "skipped", skipReason: "rate_limited" });

    addRun(dollar, 44 * DAY, "initial", {
      status: "succeeded",
      fetched: totalOf(dollar),
      inserted: totalOf(dollar),
    });
    addRun(dollar, 8 * HOUR, "background", { status: "succeeded", fetched: 3, inserted: 1 });
    addRun(dollar, 6 * HOUR, "background", { status: "succeeded", fetched: 3, inserted: 0 });
    addRun(dollar, 1 * HOUR, "background", { status: "skipped", skipReason: "daily_cap" });

    addRun(prepaid, 2 * HOUR, "background", { status: "skipped", skipReason: "no_provider_uid" });

    addRun(stale, 59 * DAY, "initial", {
      status: "succeeded",
      fetched: totalOf(stale),
      inserted: totalOf(stale),
    });
    addRun(stale, 104 * HOUR, "background", { status: "succeeded", fetched: 5, inserted: 2 });
    addRun(stale, 100 * HOUR, "background", {
      status: "failed",
      errorCode: "EXPIRED_SESSION",
      errorMessage: "The consent has expired and needs to be renewed",
    });
    addRun(stale, 26 * HOUR, "background", {
      status: "skipped",
      skipReason: "connection_inactive",
    });

    addRun(card, 38 * DAY, "initial", { status: "succeeded", fetched: 6, inserted: 6 });
    addRun(card, 3 * HOUR, "background", { status: "skipped", skipReason: "account_inactive" });

    addRun(mortgage, 60 * DAY, "initial", {
      status: "succeeded",
      fetched: totalOf(mortgage),
      inserted: totalOf(mortgage),
    });
    addRun(mortgage, 12 * DAY, "background", {
      status: "failed",
      errorCode: "REVOKED_SESSION",
      errorMessage: "The consent was withdrawn at the bank",
    });
    addRun(mortgage, 1 * DAY, "background", {
      status: "skipped",
      skipReason: "connection_inactive",
    });

    addRun(failing, 39 * DAY, "initial", {
      status: "succeeded",
      fetched: totalOf(failing),
      inserted: totalOf(failing),
    });
    addRun(failing, 31 * HOUR, "background", { status: "succeeded", fetched: 4, inserted: 1 });
    for (const hours of [28, 22, 16, 10]) {
      addRun(failing, hours * HOUR, "background", {
        status: "failed",
        errorCode: "ACCESS_DENIED",
        errorMessage: "The bank refused access to the account data",
      });
    }

    addRun(removed, 89 * DAY, "initial", {
      status: "succeeded",
      fetched: totalOf(removed),
      inserted: totalOf(removed),
    });
    addRun(removed, 21 * DAY, "background", { status: "succeeded", fetched: 3, inserted: 1 });

    // Notifications and backup ------------------------------------------------------------

    const failingRow = repo.getAccount(failing);
    const failingName = failingRow ? accountDisplayName(failingRow, "en") : "Account";
    const expiringUntil = repo.getConnection(northwind)?.validUntil ?? localNoon(9);
    ctx.db
      .insert(notifications)
      .values([
        {
          event: "consent_expiring",
          dedupeKey: `consent-expiring:${northwind}:${expiringUntil}:14`,
          params: JSON.stringify({ bankName: "Northwind Bank", days: 9 }),
          link: "/accounts",
          createdAt: ago(5 * DAY),
          readAt: null,
          emailStatus: "skipped",
          emailSentAt: null,
          emailError: null,
        },
        {
          event: "sync_failing",
          dedupeKey: `sync-failing:${failing}:${addDays(today, -2)}`,
          params: JSON.stringify({ accountName: failingName }),
          link: `/accounts/${failing}`,
          createdAt: ago(3 * HOUR),
          readAt: ago(2 * HOUR),
          emailStatus: "sent",
          emailSentAt: ago(3 * HOUR - 4_000),
          emailError: null,
        },
      ])
      .run();

    const backupStartedAt = ago(7 * HOUR);
    ctx.db
      .insert(backupRuns)
      .values({
        setId: `${new Date(backupStartedAt).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
        trigger: "scheduled",
        status: "succeeded",
        target: "local",
        startedAt: backupStartedAt,
        finishedAt: backupStartedAt + 42_000,
        sizeBytes: 1_843_200,
        errorMessage: null,
      })
      .run();
  });
}
