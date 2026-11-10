import { createHash } from "node:crypto";
import type { EnableBankingApi, TransactionsQuery } from "./client";
import { EnableBankingError } from "./errors";
import type {
  EbAccountResource,
  EbApplication,
  EbAspsp,
  EbBalance,
  EbSession,
  EbSessionStatus,
  EbStartAuthorizationRequest,
  EbStartAuthorizationResponse,
  EbTransaction,
  EbTransactionsPage,
} from "./schemas";

/**
 * Deterministic, offline Enable Banking used by the QA server and the stories. All data is
 * fictional. Authorisation redirects straight back to Bursar's callback, so a connect completes
 * without leaving the machine. It never touches the network.
 */

const DAY_MS = 86_400_000;
const CALLBACK_PATH = "/api/banks/callback";
const UNKNOWN_SESSION_VALIDITY_MS = 90 * DAY_MS;

export const FAKE_COUNTRIES = ["IT", "DE", "FI"] as const;
export const FAKE_ASPSP_NAMES = ["Banca Esempio", "Northwind Bank"] as const;
export const FAKE_PAGE_SIZE = 10;
export const FAKE_TRANSACTION_COUNT = 25;

type FakeAspspName = (typeof FAKE_ASPSP_NAMES)[number];
type SessionStatusValue = EbSessionStatus["status"];

interface AccountTemplate {
  product: string;
  details: string;
  cashAccountType: "CACC" | "SVGS";
  currency: string;
}

const ACCOUNT_TEMPLATES: Record<FakeAspspName, readonly AccountTemplate[]> = {
  "Banca Esempio": [
    {
      product: "Conto Esempio",
      details: "Current account",
      cashAccountType: "CACC",
      currency: "EUR",
    },
    {
      product: "Deposito Esempio",
      details: "Savings account",
      cashAccountType: "SVGS",
      currency: "EUR",
    },
  ],
  "Northwind Bank": [
    {
      product: "Everyday Account",
      details: "Current account",
      cashAccountType: "CACC",
      currency: "EUR",
    },
    {
      product: "Dollar Account",
      details: "Foreign currency account",
      cashAccountType: "CACC",
      currency: "USD",
    },
  ],
};

const COUNTERPARTIES = [
  "Grocery Market",
  "City Utilities",
  "Coffee Corner",
  "Online Bookshop",
  "Fuel Station",
  "Pharmacy Central",
  "Mobile Operator",
  "Rail Tickets",
] as const;

function isFakeAspsp(name: string): name is FakeAspspName {
  return (FAKE_ASPSP_NAMES as readonly string[]).includes(name);
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function fakeUuid(kind: number, n: number): string {
  return `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Non-negative integer minor units (2 decimals) to the provider's decimal string. */
function minorToAmount(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

function ibanCheckDigits(country: string, bban: string): string {
  let remainder = 0;
  for (const char of `${bban}${country}00`.toUpperCase()) {
    const value = /[A-Z]/.test(char) ? char.charCodeAt(0) - 55 : Number(char);
    remainder = value >= 10 ? (remainder * 100 + value) % 97 : (remainder * 10 + value) % 97;
  }
  return String(98 - remainder).padStart(2, "0");
}

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

export interface FakeAccountIdentity {
  identificationHash: string;
  identificationHashes: string[];
  /** Italian IBAN with a valid checksum for `IT`, otherwise null (the account uses `bban`). */
  iban: string | null;
  bban: string;
}

/**
 * The identity of the `index`-th account the fake returns for a bank. Stable across sessions and
 * runs, so renewals map to the same Bursar accounts (eb-api-notes.md §5).
 */
export function fakeAccountIdentity(
  country: string,
  aspspName: string,
  index: number,
): FakeAccountIdentity {
  const digest = sha256(`bursar-fake:${country}:${aspspName}:${index}`);
  const identificationHash = digest.toString("base64url");
  const alternateHash = sha256(`bursar-fake-bban:${country}:${aspspName}:${index}`).toString(
    "base64url",
  );
  const accountNumber = String(
    (digest.readUInt32BE(0) % 1_000_000_000) * 1000 + (digest.readUInt16BE(4) % 1000),
  ).padStart(12, "0");
  if (country === "IT") {
    const bban = `X0999901600${accountNumber}`;
    return {
      identificationHash,
      identificationHashes: [identificationHash, alternateHash],
      iban: `IT${ibanCheckDigits("IT", bban)}${bban}`,
      bban,
    };
  }
  return {
    identificationHash,
    identificationHashes: [identificationHash, alternateHash],
    iban: null,
    bban: `${country}${accountNumber}`,
  };
}

function sessionEndedError(status: SessionStatusValue): EnableBankingError {
  switch (status) {
    case "EXPIRED":
      return new EnableBankingError(401, "EXPIRED_SESSION", "Session expired");
    case "CLOSED":
      return new EnableBankingError(400, "CLOSED_SESSION", "Session is closed");
    case "REVOKED":
      return new EnableBankingError(400, "REVOKED_SESSION", "Session is revoked");
    default:
      return new EnableBankingError(400, "WRONG_SESSION_STATUS", "Wrong session status");
  }
}

function transactionDate(tx: EbTransaction): string {
  return tx.booking_date ?? tx.value_date ?? tx.transaction_date ?? "";
}

interface IssuedCode {
  aspsp: { name: FakeAspspName; country: string };
  validUntil: string;
  used: boolean;
}

export class FakeEnableBanking implements EnableBankingApi {
  readonly sessions = new Map<
    string,
    { status: SessionStatusValue; accounts: EbAccountResource[] }
  >();
  private readonly publicUrl: URL;
  private readonly now: () => number;
  private readonly seed: number;
  private readonly failures = new Map<keyof EnableBankingApi, EnableBankingError[]>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly validity = new Map<string, string>();
  private counter = 0;

  constructor(options: { publicUrl: URL; now?: () => number; seed?: number }) {
    this.publicUrl = options.publicUrl;
    this.now = options.now ?? Date.now;
    this.seed = options.seed ?? 1;
  }

  failNext(method: keyof EnableBankingApi, error: EnableBankingError): void {
    const queued = this.failures.get(method) ?? [];
    queued.push(error);
    this.failures.set(method, queued);
  }

  async getApplication(): Promise<EbApplication> {
    this.takeFailure("getApplication");
    return {
      name: "Bursar (fake bank)",
      kid: fakeUuid(0xfa, 1),
      environment: "SANDBOX",
      redirect_urls: [this.callbackUrl()],
      active: true,
      countries: [...FAKE_COUNTRIES],
    };
  }

  async listAspsps(country: string): Promise<EbAspsp[]> {
    this.takeFailure("listAspsps");
    const code = country.toUpperCase();
    return FAKE_ASPSP_NAMES.map((name, index) => ({
      name,
      country: code,
      // Empty logo: the panel shows initials and the logo proxy never reaches the network in QA.
      logo: "",
      psu_types: ["personal"],
      maximum_consent_validity: (index === 0 ? 180 : 90) * 86_400,
      beta: index === 1,
      bic: null,
      required_psu_headers: ["Psu-Ip-Address", "Psu-User-Agent"],
    }));
  }

  async startAuthorization(
    request: EbStartAuthorizationRequest,
  ): Promise<EbStartAuthorizationResponse> {
    this.takeFailure("startAuthorization");
    const name = request.aspsp.name;
    if (!isFakeAspsp(name)) {
      throw new EnableBankingError(400, "WRONG_ASPSP_PROVIDED", "Wrong ASPSP provided");
    }
    if (request.redirect_url !== this.callbackUrl()) {
      throw new EnableBankingError(400, "REDIRECT_URI_NOT_ALLOWED", "Redirect URI not allowed");
    }
    this.counter += 1;
    const code = `fake-${this.counter}`;
    this.codes.set(code, {
      aspsp: { name, country: request.aspsp.country },
      validUntil: request.access.valid_until,
      used: false,
    });
    const redirect = new URL(request.redirect_url);
    redirect.searchParams.set("state", request.state);
    redirect.searchParams.set("code", code);
    return {
      url: redirect.href,
      authorization_id: fakeUuid(0xa1, this.counter),
      psu_id_hash: `fake-psu-${this.seed}`,
    };
  }

  async createSession(code: string): Promise<EbSession> {
    this.takeFailure("createSession");
    if (code.startsWith("fake-empty-")) {
      this.counter += 1;
      const sessionId = fakeUuid(0x5e, this.counter);
      const validUntil = new Date(this.now() + UNKNOWN_SESSION_VALIDITY_MS).toISOString();
      this.sessions.set(sessionId, { status: "AUTHORIZED", accounts: [] });
      this.validity.set(sessionId, validUntil);
      return {
        session_id: sessionId,
        accounts: [],
        aspsp: { name: FAKE_ASPSP_NAMES[0], country: "IT" },
        psu_type: "personal",
        access: { valid_until: validUntil },
      };
    }
    const issued = this.codes.get(code);
    if (!issued) {
      throw new EnableBankingError(400, "WRONG_AUTHORIZATION_CODE", "Wrong authorization code");
    }
    if (issued.used) {
      throw new EnableBankingError(400, "ALREADY_AUTHORIZED", "Session is already authorized");
    }
    issued.used = true;
    this.counter += 1;
    const sessionId = fakeUuid(0x5e, this.counter);
    const accounts = ACCOUNT_TEMPLATES[issued.aspsp.name].map((template, index) =>
      this.accountResource(
        issued.aspsp,
        template,
        index,
        fakeUuid(0xac, this.counter * 16 + index),
      ),
    );
    this.sessions.set(sessionId, { status: "AUTHORIZED", accounts });
    this.validity.set(sessionId, issued.validUntil);
    return {
      session_id: sessionId,
      accounts,
      aspsp: { ...issued.aspsp },
      psu_type: "personal",
      access: { valid_until: issued.validUntil },
    };
  }

  async getSession(sessionId: string): Promise<EbSessionStatus> {
    this.takeFailure("getSession");
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Sessions seeded directly into the QA database are unknown here: report them as healthy.
      return {
        status: "AUTHORIZED",
        accounts: [],
        access: { valid_until: new Date(this.now() + UNKNOWN_SESSION_VALIDITY_MS).toISOString() },
      };
    }
    this.expireIfDue(sessionId, session);
    return {
      status: session.status,
      accounts: session.accounts.flatMap((account) => (account.uid ? [account.uid] : [])),
      access: { valid_until: this.validity.get(sessionId) ?? new Date(this.now()).toISOString() },
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.takeFailure("deleteSession");
    const session = this.sessions.get(sessionId);
    if (session) session.status = "CLOSED";
  }

  async getBalances(accountUid: string): Promise<EbBalance[]> {
    this.takeFailure("getBalances");
    const { hash, currency } = this.accountFor(accountUid);
    const random = mulberry32(this.seedFor(hash));
    const booked = 50_000 + Math.floor(random() * 900_000);
    const available = booked - Math.floor(random() * 20_000);
    const now = this.now();
    return [
      {
        name: "Closing booked",
        balance_amount: { currency, amount: minorToAmount(booked) },
        balance_type: "CLBD",
        reference_date: isoDate(now - DAY_MS),
      },
      {
        name: "Interim available",
        balance_amount: { currency, amount: minorToAmount(available) },
        balance_type: "ITAV",
        reference_date: isoDate(now),
        last_change_date_time: new Date(now).toISOString(),
      },
    ];
  }

  async getTransactions(accountUid: string, query: TransactionsQuery): Promise<EbTransactionsPage> {
    this.takeFailure("getTransactions");
    const { hash, currency } = this.accountFor(accountUid);
    let all = this.transactionsFor(hash, currency);
    const { dateFrom, dateTo } = query;
    if (dateFrom) all = all.filter((tx) => transactionDate(tx) >= dateFrom);
    // Like the real API, `longest` ignores date_to (eb-api-notes.md §7).
    if (dateTo && query.strategy !== "longest") {
      all = all.filter((tx) => transactionDate(tx) <= dateTo);
    }
    let offset = 0;
    if (query.continuationKey !== undefined) {
      const match = /^fake-page-(\d+)$/.exec(query.continuationKey);
      if (!match) {
        throw new EnableBankingError(400, "WRONG_CONTINUATION_KEY", "Wrong continuation key");
      }
      offset = Number(match[1]);
    }
    const next = offset + FAKE_PAGE_SIZE;
    return {
      transactions: all.slice(offset, next),
      continuation_key: next < all.length ? `fake-page-${next}` : null,
    };
  }

  private callbackUrl(): string {
    return new URL(CALLBACK_PATH, this.publicUrl).href;
  }

  private takeFailure(method: keyof EnableBankingApi): void {
    const next = this.failures.get(method)?.shift();
    if (next) throw next;
  }

  private seedFor(hash: string): number {
    return sha256(`${this.seed}:${hash}`).readUInt32BE(0);
  }

  private expireIfDue(
    sessionId: string,
    session: { status: SessionStatusValue; accounts: EbAccountResource[] },
  ): void {
    const validUntil = Date.parse(this.validity.get(sessionId) ?? "");
    if (
      session.status === "AUTHORIZED" &&
      Number.isFinite(validUntil) &&
      validUntil <= this.now()
    ) {
      session.status = "EXPIRED";
    }
  }

  private accountFor(uid: string): { hash: string; currency: string } {
    for (const [sessionId, session] of this.sessions) {
      const resource = session.accounts.find((account) => account.uid === uid);
      if (!resource) continue;
      this.expireIfDue(sessionId, session);
      if (session.status !== "AUTHORIZED") throw sessionEndedError(session.status);
      return { hash: resource.identification_hash, currency: resource.currency };
    }
    // Accounts seeded directly into the QA database: serve deterministic EUR data for them.
    return { hash: `unknown:${uid}`, currency: "EUR" };
  }

  private accountResource(
    aspsp: { name: FakeAspspName; country: string },
    template: AccountTemplate,
    index: number,
    uid: string,
  ): EbAccountResource {
    const identity = fakeAccountIdentity(aspsp.country, aspsp.name, index);
    const primary = identity.iban
      ? { identification: identity.iban, scheme_name: "IBAN" }
      : { identification: identity.bban, scheme_name: "BBAN" };
    return {
      uid,
      account_id: identity.iban ? { iban: identity.iban } : { other: primary },
      all_account_ids: [primary],
      account_servicer: { bic_fi: null, name: aspsp.name },
      name: "Example Holder",
      details: template.details,
      product: template.product,
      cash_account_type: template.cashAccountType,
      currency: template.currency,
      identification_hash: identity.identificationHash,
      identification_hashes: identity.identificationHashes,
      usage: "PRIV",
    };
  }

  private transactionsFor(hash: string, currency: string): EbTransaction[] {
    const random = mulberry32(this.seedFor(hash));
    const prefix = hash
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 8)
      .toUpperCase();
    const now = this.now();
    const transactions: EbTransaction[] = [];
    for (let i = 0; i < FAKE_TRANSACTION_COUNT; i += 1) {
      const date = isoDate(now - i * 2 * DAY_MS);
      const pending = i === 0;
      const salary = i % 10 === 5;
      const minor = salary ? 215_000 : 150 + Math.floor(random() * 12_000);
      const counterparty = salary
        ? "Example Employer Ltd"
        : (COUNTERPARTIES[Math.floor(random() * COUNTERPARTIES.length)] ?? COUNTERPARTIES[0]);
      transactions.push({
        entry_reference: pending
          ? null
          : `${prefix}-${String(FAKE_TRANSACTION_COUNT - i).padStart(4, "0")}`,
        transaction_id: null,
        transaction_amount: { currency, amount: minorToAmount(minor) },
        credit_debit_indicator: salary ? "CRDT" : "DBIT",
        status: pending ? "PDNG" : "BOOK",
        booking_date: pending ? null : date,
        value_date: date,
        transaction_date: date,
        creditor: salary ? null : { name: counterparty },
        debtor: salary ? { name: counterparty } : null,
        remittance_information: salary
          ? ["Salary", `Period ${date.slice(0, 7)}`]
          : [`Card payment ${counterparty}`],
        bank_transaction_code: salary
          ? { description: "Credit transfer", code: "RCDT", sub_code: "ESCT" }
          : { description: "Card payment", code: "CCRD", sub_code: "POSD" },
      });
    }
    return transactions;
  }
}
