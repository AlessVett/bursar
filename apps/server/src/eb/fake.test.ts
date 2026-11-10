import { isValidIban } from "@bursar/shared";
import { describe, expect, it } from "vitest";
import { EnableBankingError } from "./errors";
import {
  FAKE_ASPSP_NAMES,
  FAKE_PAGE_SIZE,
  FAKE_TRANSACTION_COUNT,
  FakeEnableBanking,
} from "./fake";
import {
  type EbTransaction,
  ebAspspSchema,
  ebSessionSchema,
  ebTransactionsPageSchema,
} from "./schemas";

const PUBLIC_URL = new URL("http://127.0.0.1:4100");
const CALLBACK = "http://127.0.0.1:4100/api/banks/callback";
const NOW_MS = Date.UTC(2026, 10, 9, 9, 0, 0);
const VALID_UNTIL = "2027-05-08T09:00:00.000000+00:00";

function fakeBank(options: { seed?: number; now?: () => number } = {}) {
  return new FakeEnableBanking({
    publicUrl: PUBLIC_URL,
    now: options.now ?? (() => NOW_MS),
    seed: options.seed,
  });
}

async function connect(
  bank: FakeEnableBanking,
  options: { aspspName?: string; validUntil?: string } = {},
) {
  const started = await bank.startAuthorization({
    access: { valid_until: options.validUntil ?? VALID_UNTIL },
    aspsp: { name: options.aspspName ?? FAKE_ASPSP_NAMES[0], country: "IT" },
    state: "state-0123456789abcdef",
    redirect_url: CALLBACK,
    psu_type: "personal",
    language: "it",
  });
  const redirect = new URL(started.url);
  const code = redirect.searchParams.get("code") ?? "";
  return { redirect, code, session: await bank.createSession(code) };
}

async function allTransactions(bank: FakeEnableBanking, uid: string) {
  const transactions: EbTransaction[] = [];
  let key: string | undefined;
  let pages = 0;
  do {
    const page = await bank.getTransactions(uid, key ? { continuationKey: key } : {});
    ebTransactionsPageSchema.parse(page);
    transactions.push(...page.transactions);
    key = page.continuation_key ?? undefined;
    pages += 1;
  } while (key && pages < 20);
  return { transactions, pages };
}

async function rejection(promise: Promise<unknown>): Promise<EnableBankingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EnableBankingError) return error;
    throw error;
  }
  throw new Error("Expected an EnableBankingError");
}

describe("FakeEnableBanking", () => {
  it("lists two fictional banks per country in the documented shape", async () => {
    const bank = fakeBank();
    const italian = await bank.listAspsps("IT");
    expect(italian.map((aspsp) => aspsp.name)).toEqual([...FAKE_ASPSP_NAMES]);
    for (const aspsp of italian) {
      expect(ebAspspSchema.parse(aspsp).country).toBe("IT");
    }
    expect((await bank.listAspsps("DE"))[0]?.country).toBe("DE");
    const application = await bank.getApplication();
    expect(application.redirect_urls).toEqual([CALLBACK]);
  });

  it("redirects back to the callback with the state and a code", async () => {
    const { redirect, code } = await connect(fakeBank());
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CALLBACK);
    expect(redirect.searchParams.get("state")).toBe("state-0123456789abcdef");
    expect(code).toMatch(/^fake-\d+$/);
  });

  it("completes a round trip from authorization to paginated transactions", async () => {
    const bank = fakeBank();
    const { session } = await connect(bank);
    expect(ebSessionSchema.parse(session).accounts).toHaveLength(2);
    expect(session.access.valid_until).toBe(VALID_UNTIL);
    for (const account of session.accounts) {
      expect(account.uid).toMatch(/^[0-9a-f-]{36}$/);
      expect(isValidIban(account.account_id?.iban ?? "")).toBe(true);
    }
    const status = await bank.getSession(session.session_id);
    expect(status.status).toBe("AUTHORIZED");
    expect(status.accounts).toEqual(session.accounts.map((account) => account.uid));

    const uid = session.accounts[0]?.uid ?? "";
    const firstPage = await bank.getTransactions(uid, {});
    expect(firstPage.transactions).toHaveLength(FAKE_PAGE_SIZE);
    expect(firstPage.continuation_key).toBe(`fake-page-${FAKE_PAGE_SIZE}`);
    const { transactions, pages } = await allTransactions(bank, uid);
    expect(transactions).toHaveLength(FAKE_TRANSACTION_COUNT);
    expect(pages).toBe(3);
    expect(transactions[0]?.status).toBe("PDNG");
    expect(transactions[0]?.booking_date).toBeNull();
    const references = transactions.flatMap((tx) =>
      tx.entry_reference ? [tx.entry_reference] : [],
    );
    expect(new Set(references).size).toBe(FAKE_TRANSACTION_COUNT - 1);
    expect((await bank.getBalances(uid)).map((balance) => balance.balance_type)).toEqual([
      "CLBD",
      "ITAV",
    ]);
  });

  it("keeps identification hashes stable across sessions", async () => {
    const bank = fakeBank();
    const first = await connect(bank);
    const second = await connect(bank);
    expect(second.session.session_id).not.toBe(first.session.session_id);
    expect(second.session.accounts.map((account) => account.identification_hash)).toEqual(
      first.session.accounts.map((account) => account.identification_hash),
    );
    expect(second.session.accounts[0]?.uid).not.toBe(first.session.accounts[0]?.uid);
    const before = await allTransactions(bank, first.session.accounts[0]?.uid ?? "");
    const after = await allTransactions(bank, second.session.accounts[0]?.uid ?? "");
    expect(after.transactions.map((tx) => tx.entry_reference)).toEqual(
      before.transactions.map((tx) => tx.entry_reference),
    );
  });

  it("returns no accounts for an empty-session code", async () => {
    const session = await fakeBank().createSession("fake-empty-1");
    expect(session.accounts).toEqual([]);
    expect(ebSessionSchema.parse(session).session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects unknown and reused codes", async () => {
    const bank = fakeBank();
    expect((await rejection(bank.createSession("nope"))).code).toBe("WRONG_AUTHORIZATION_CODE");
    const { code } = await connect(bank);
    expect((await rejection(bank.createSession(code))).code).toBe("ALREADY_AUTHORIZED");
  });

  it("rejects a redirect URL that is not the callback and an unknown bank", async () => {
    const bank = fakeBank();
    const base = {
      access: { valid_until: VALID_UNTIL },
      state: "state-0123456789abcdef",
      psu_type: "personal" as const,
    };
    const wrongRedirect = await rejection(
      bank.startAuthorization({
        ...base,
        aspsp: { name: FAKE_ASPSP_NAMES[0], country: "IT" },
        redirect_url: "https://evil.example.test/callback",
      }),
    );
    expect(wrongRedirect.code).toBe("REDIRECT_URI_NOT_ALLOWED");
    const wrongBank = await rejection(
      bank.startAuthorization({
        ...base,
        aspsp: { name: "Unknown Bank", country: "IT" },
        redirect_url: CALLBACK,
      }),
    );
    expect(wrongBank.code).toBe("WRONG_ASPSP_PROVIDED");
  });

  it("fails the next call when asked", async () => {
    const bank = fakeBank();
    const { session } = await connect(bank);
    const uid = session.accounts[0]?.uid ?? "";
    bank.failNext(
      "getBalances",
      new EnableBankingError(429, "ASPSP_RATE_LIMIT_EXCEEDED", "Rate limit exceeded"),
    );
    expect((await rejection(bank.getBalances(uid))).kind).toBe("rate_limited");
    await expect(bank.getBalances(uid)).resolves.toHaveLength(2);
  });

  it("ends sessions on delete and on expiry", async () => {
    let now = NOW_MS;
    const bank = fakeBank({ now: () => now });
    const closed = await connect(bank);
    await bank.deleteSession(closed.session.session_id);
    expect(bank.sessions.get(closed.session.session_id)?.status).toBe("CLOSED");
    const closedError = await rejection(bank.getBalances(closed.session.accounts[0]?.uid ?? ""));
    expect([closedError.code, closedError.kind]).toEqual(["CLOSED_SESSION", "reauth"]);

    const shortLived = await connect(bank, {
      validUntil: new Date(NOW_MS + 3_600_000).toISOString(),
    });
    now = NOW_MS + 7_200_000;
    const expiredError = await rejection(
      bank.getTransactions(shortLived.session.accounts[0]?.uid ?? "", {}),
    );
    expect([expiredError.code, expiredError.kind]).toEqual(["EXPIRED_SESSION", "reauth"]);
    expect((await bank.getSession(shortLived.session.session_id)).status).toBe("EXPIRED");
  });

  it("is deterministic for a seed and a clock", async () => {
    const amounts = async (seed: number) => {
      const bank = fakeBank({ seed });
      const { session } = await connect(bank);
      const { transactions } = await allTransactions(bank, session.accounts[0]?.uid ?? "");
      return transactions.map((tx) => tx.transaction_amount.amount);
    };
    expect(await amounts(7)).toEqual(await amounts(7));
    expect(await amounts(7)).not.toEqual(await amounts(8));
  });

  it("serves data for accounts and sessions it did not create (QA seed data)", async () => {
    const bank = fakeBank();
    const uid = "00000000-0000-4000-8000-00000000abcd";
    const balances = await bank.getBalances(uid);
    expect(balances.map((balance) => balance.balance_amount.currency)).toEqual(["EUR", "EUR"]);
    expect((await bank.getTransactions(uid, {})).transactions).toHaveLength(FAKE_PAGE_SIZE);
    const status = await bank.getSession("00000000-0000-4000-8000-0000000000ff");
    expect(status.status).toBe("AUTHORIZED");
  });
});
