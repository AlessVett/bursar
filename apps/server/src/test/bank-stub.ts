import type { EnableBankingApi } from "../eb/client";
import { type EnableBankingError, parseEbErrorBody } from "../eb/errors";
import type {
  EbAccountResource,
  EbApplication,
  EbAspsp,
  EbBalance,
  EbSession,
  EbSessionStatus,
  EbStartAuthorizationRequest,
  EbStartAuthorizationResponse,
  EbTransactionsPage,
} from "../eb/schemas";

/**
 * Test kit for the connect flow: an in-memory `EnableBankingApi` and fixtures shaped like the
 * documented Enable Banking responses (eb-api-notes §2, §3, §5, §9). All data is fictional: the
 * IBANs use the unassigned bank code 99001 with valid check digits.
 */

export const BANK_NAME = "Banca Esempio";
export const OTHER_BANK_NAME = "Northwind Bank";
export const AUTH_URL =
  "https://auth.enablebanking.com/ais/start?sessionid=7d1f0c3e-2b4a-4c5d-8e6f-000000000001";

export const IBAN_CURRENT = "IT89X9900101600000000001001";
export const IBAN_SAVINGS = "IT28X9900101600000000002002";
export const IBAN_USD = "IT64X9900101600000000003003";
export const CARD_NUMBER = "5100000000005678";

export const HASH_CURRENT = "hash-current";
export const HASH_SAVINGS = "hash-savings";
export const HASH_USD = "hash-usd";
export const HASH_CARD = "hash-card";

/** Account uid as returned by `POST /sessions` (uuid). */
export function testUid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Session id as returned by `POST /sessions` (uuid4). */
export function testSessionId(n: number): string {
  return `5e550000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function aspspFixture(overrides: Partial<EbAspsp> = {}): EbAspsp {
  return {
    name: BANK_NAME,
    country: "IT",
    logo: "https://logos.example.test/banca-esempio.png",
    psu_types: ["personal", "business"],
    auth_methods: [],
    maximum_consent_validity: 15_552_000,
    beta: false,
    bic: "BESPITM1XXX",
    required_psu_headers: null,
    ...overrides,
  };
}

export type AccountKind = "current" | "savings" | "usd" | "card";

const SERVICER = { bic_fi: "BESPITM1XXX", name: BANK_NAME };

function ibanAccount(
  uid: number,
  iban: string,
  hash: string,
  product: string,
  cashAccountType: string,
  currency: string,
): EbAccountResource {
  return {
    uid: testUid(uid),
    account_id: { iban },
    all_account_ids: [{ identification: iban, scheme_name: "IBAN" }],
    account_servicer: SERVICER,
    name: "Alex Example",
    details: null,
    product,
    cash_account_type: cashAccountType,
    currency,
    identification_hash: hash,
    identification_hashes: [hash, `${hash}-bban`],
    usage: "PRIV",
  };
}

const ACCOUNTS: Record<AccountKind, () => EbAccountResource> = {
  current: () =>
    ibanAccount(1, IBAN_CURRENT, HASH_CURRENT, "Conto Corrente Esempio", "CACC", "EUR"),
  savings: () =>
    ibanAccount(2, IBAN_SAVINGS, HASH_SAVINGS, "Libretto Risparmio Esempio", "SVGS", "EUR"),
  usd: () => ibanAccount(3, IBAN_USD, HASH_USD, "Conto Valuta Esempio", "CACC", "USD"),
  // A card the bank cannot serve data for: no uid (eb-api-notes §5).
  card: () => ({
    uid: null,
    account_id: { other: { identification: CARD_NUMBER, scheme_name: "CPAN" } },
    all_account_ids: [{ identification: CARD_NUMBER, scheme_name: "CPAN" }],
    account_servicer: SERVICER,
    name: "Alex Example",
    details: "Carta di credito",
    product: "Carta Esempio",
    cash_account_type: "CARD",
    currency: "EUR",
    identification_hash: HASH_CARD,
    identification_hashes: [HASH_CARD],
    usage: "PRIV",
  }),
};

export function accountResource(
  kind: AccountKind,
  overrides: Partial<EbAccountResource> = {},
): EbAccountResource {
  return { ...ACCOUNTS[kind](), ...overrides };
}

/** `POST /sessions` response; `valid_until` uses the microsecond format of the API examples. */
export function sessionFixture(
  n: number,
  accounts: EbAccountResource[],
  options: { aspspName?: string; validUntil?: string } = {},
): EbSession {
  return {
    session_id: testSessionId(n),
    accounts,
    aspsp: { name: options.aspspName ?? BANK_NAME, country: "IT" },
    psu_type: "personal",
    access: { valid_until: options.validUntil ?? "2027-05-08T09:50:00.000000+00:00" },
  };
}

/** An Enable Banking error built from a documented `ErrorResponse` body. */
export function ebError(status: number, error: string, message: string): EnableBankingError {
  return parseEbErrorBody(status, { message, code: status, error });
}

export class StubBank implements EnableBankingApi {
  aspspList: EbAspsp[] = [
    aspspFixture(),
    aspspFixture({
      name: OTHER_BANK_NAME,
      logo: "https://logos.example.test/northwind.png",
      maximum_consent_validity: 7_776_000,
      bic: "NWBKITM1XXX",
    }),
  ];
  authUrl = AUTH_URL;
  listError: Error | null = null;
  startError: Error | null = null;
  createSessionError: Error | null = null;
  deleteSessionError: Error | null = null;
  readonly startCalls: EbStartAuthorizationRequest[] = [];
  readonly exchangedCodes: string[] = [];
  readonly deletedSessions: string[] = [];
  private readonly sessionsByCode = new Map<string, EbSession>();

  /** The session the exchange of `code` returns. */
  willReturn(code: string, session: EbSession): void {
    this.sessionsByCode.set(code, session);
  }

  /** The `state` of the last `startAuthorization` call (what the bank would send back). */
  lastState(): string {
    const call = this.startCalls.at(-1);
    if (!call) throw new Error("startAuthorization was not called");
    return call.state;
  }

  async getApplication(): Promise<EbApplication> {
    throw new Error("getApplication is not used by the connect flow");
  }

  async listAspsps(country: string): Promise<EbAspsp[]> {
    if (this.listError) throw this.listError;
    return this.aspspList.filter((aspsp) => aspsp.country === country);
  }

  async startAuthorization(
    request: EbStartAuthorizationRequest,
  ): Promise<EbStartAuthorizationResponse> {
    this.startCalls.push(request);
    if (this.startError) throw this.startError;
    return {
      url: this.authUrl,
      authorization_id: "a0a0a0a0-0000-4000-8000-000000000001",
      psu_id_hash: "psu-hash-0001",
    };
  }

  async createSession(code: string): Promise<EbSession> {
    this.exchangedCodes.push(code);
    if (this.createSessionError) throw this.createSessionError;
    const session = this.sessionsByCode.get(code);
    if (!session) throw ebError(400, "WRONG_AUTHORIZATION_CODE", "Wrong authorization code");
    return session;
  }

  async getSession(): Promise<EbSessionStatus> {
    throw new Error("getSession is not used by the connect flow");
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessions.push(sessionId);
    if (this.deleteSessionError) throw this.deleteSessionError;
  }

  async getBalances(): Promise<EbBalance[]> {
    throw new Error("getBalances is not used by the connect flow");
  }

  async getTransactions(): Promise<EbTransactionsPage> {
    throw new Error("getTransactions is not used by the connect flow");
  }
}
