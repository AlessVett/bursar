import { createHash } from "node:crypto";
import type { CompleteConnectionResponse, ServerEvent } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../audit";
import { AspspCache } from "../eb/aspsp-cache";
import { parseEbErrorBody } from "../eb/errors";
import type { EbAccountResource } from "../eb/schemas";
import { EventBus } from "../events/bus";
import { JobQueue } from "../jobs/queue";
import { DELETE_SESSION_JOB, SYNC_ACCOUNT_JOB } from "../jobs/types";
import { SettingsStore } from "../settings/store";
import {
  AUTH_URL,
  accountResource,
  aspspFixture,
  BANK_NAME,
  ebError,
  HASH_CURRENT,
  HASH_SAVINGS,
  IBAN_CURRENT,
  IBAN_USD,
  OTHER_BANK_NAME,
  StubBank,
  sessionFixture,
  testSessionId,
  testUid,
} from "../test/bank-stub";
import { createTestDatabase, type TestDatabase } from "../test/db";
import {
  AUTH_REQUEST_TTL_MS,
  ConnectError,
  ConnectService,
  type ConnectServiceDeps,
} from "./connect";
import { FinanceRepository } from "./repository";

const START = Date.parse("2026-11-09T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const PUBLIC_URL = new URL("https://bursar.example.test");
const STATE_1 = "test-state-0001-0123456789abcdef";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

interface JobRow {
  type: string;
  payload: unknown;
  dedupeKey: string | null;
  status: string;
}

async function rejection(promise: Promise<unknown>): Promise<ConnectError> {
  const reason = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(reason).toBeInstanceOf(ConnectError);
  return reason as ConnectError;
}

function connectionIdOf(result: CompleteConnectionResponse): number {
  if (result.connectionId === null) throw new Error(`no connection for outcome ${result.outcome}`);
  return result.connectionId;
}

function accountIdAt(result: CompleteConnectionResponse, index: number): number {
  const account = result.accounts[index];
  if (!account) throw new Error(`no account at index ${index}`);
  return account.id;
}

const idsOf = (result: CompleteConnectionResponse) => result.accounts.map((account) => account.id);

describe("ConnectService", () => {
  let t: TestDatabase;
  let now: number;
  let bank: StubBank;
  let repo: FinanceRepository;
  let queue: JobQueue;
  let settings: SettingsStore;
  let events: ServerEvent[];
  let stateCounter: number;
  let service: ConnectService;

  function makeService(overrides: Partial<ConnectServiceDeps> = {}): ConnectService {
    const clock = () => now;
    const bus = new EventBus();
    bus.subscribe((event) => events.push(event));
    return new ConnectService({
      repo,
      api: bank,
      aspsps: new AspspCache(bank, clock),
      queue,
      bus,
      audit: new AuditLog(t.db, clock),
      settings,
      publicUrl: PUBLIC_URL,
      timezone: "Europe/Rome",
      now: clock,
      randomState: () => {
        stateCounter += 1;
        return `test-state-${String(stateCounter).padStart(4, "0")}-0123456789abcdef`;
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    t = createTestDatabase();
    now = START;
    stateCounter = 0;
    events = [];
    bank = new StubBank();
    const clock = () => now;
    repo = new FinanceRepository(t.db, clock);
    queue = new JobQueue(t.sqlite, clock);
    settings = new SettingsStore(t.db, clock);
    service = makeService();
  });
  afterEach(() => t.dispose());

  const jobs = (): JobRow[] =>
    (
      t.sqlite
        .prepare("SELECT type, payload, dedupe_key AS dedupeKey, status FROM jobs ORDER BY id")
        .all() as { type: string; payload: string; dedupeKey: string | null; status: string }[]
    ).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  const queuedOf = (type: string) =>
    jobs().filter((job) => job.type === type && job.status === "queued");
  const finishJobs = () => t.sqlite.prepare("UPDATE jobs SET status = 'succeeded'").run();
  const auditRows = () =>
    (
      t.sqlite
        .prepare("SELECT actor, action, target, details FROM audit_log ORDER BY id")
        .all() as {
        actor: string;
        action: string;
        target: string | null;
        details: string | null;
      }[]
    ).map((row) => ({ ...row, details: row.details === null ? null : JSON.parse(row.details) }));
  const authRequestCount = () =>
    (t.sqlite.prepare("SELECT count(*) AS n FROM bank_auth_requests").get() as { n: number }).n;
  const insertTransaction = (accountId: number) =>
    t.sqlite
      .prepare(
        `INSERT INTO transactions (account_id, fingerprint, status, sort_date, amount_minor, currency,
           search_text, raw_json, missing_count, first_seen_at, last_seen_at)
         VALUES (?, ?, 'booked', '2026-11-02', -4250, 'EUR', 'supermercato esempio', '{}', 0, ?, ?)`,
      )
      .run(accountId, `ref:${accountId}-0001`, now, now);

  async function connect(accounts: EbAccountResource[], session = 1, bankName = BANK_NAME) {
    const code = `code-${session}`;
    bank.willReturn(code, sessionFixture(session, accounts, { aspspName: bankName }));
    await service.start({ aspspName: bankName, aspspCountry: "IT" });
    return service.complete({ state: bank.lastState(), code });
  }

  async function renew(connectionId: number, accounts: EbAccountResource[], session: number) {
    const code = `code-${session}`;
    bank.willReturn(code, sessionFixture(session, accounts));
    await service.renew(connectionId, {});
    return service.complete({ state: bank.lastState(), code });
  }

  describe("start", () => {
    it("asks for consent up to the bank maximum minus the safety margin", async () => {
      bank.aspspList = [aspspFixture({ maximum_consent_validity: 90 * 86_400 })];
      const response = await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      expect(response).toEqual({ redirectUrl: AUTH_URL });
      expect(bank.startCalls).toEqual([
        {
          access: {
            valid_until: "2027-02-07T09:50:00.000+00:00",
            balances: true,
            transactions: true,
          },
          aspsp: { name: BANK_NAME, country: "IT" },
          state: STATE_1,
          redirect_url: "https://bursar.example.test/api/banks/callback",
          psu_type: "personal",
          language: "it",
        },
      ]);
    });

    it("clamps the consent to the configured number of days", async () => {
      settings.update({ consentDays: 30 });
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      expect(bank.startCalls[0]?.access.valid_until).toBe("2026-12-09T09:50:00.000+00:00");
    });

    it("lets the request ask for fewer days but never more than the bank allows", async () => {
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT", consentDays: 7 });
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT", consentDays: 365 });
      expect(bank.startCalls.map((call) => call.access.valid_until)).toEqual([
        "2026-11-16T09:50:00.000+00:00",
        "2027-05-08T09:50:00.000+00:00",
      ]);
    });

    it("stores only the sha256 of a single-use state that expires after 30 minutes", async () => {
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      expect(
        t.sqlite
          .prepare(
            `SELECT state_hash, purpose, connection_id, aspsp_name, aspsp_country, valid_until,
               created_at, expires_at, consumed_at FROM bank_auth_requests`,
          )
          .all(),
      ).toEqual([
        {
          state_hash: sha256(STATE_1),
          purpose: "connect",
          connection_id: null,
          aspsp_name: BANK_NAME,
          aspsp_country: "IT",
          valid_until: Date.parse("2027-05-08T09:50:00.000Z"),
          created_at: START,
          expires_at: START + 30 * 60_000,
          consumed_at: null,
        },
      ]);
      expect(
        JSON.stringify(t.sqlite.prepare("SELECT * FROM bank_auth_requests").all()),
      ).not.toContain(STATE_1);
    });

    it("generates a 32-byte base64url state by default", async () => {
      service = makeService({ randomState: undefined });
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      const [first, second] = bank.startCalls.map((call) => call.state);
      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first).not.toBe(second);
    });

    it("saves the country when none is set and keeps a chosen one", async () => {
      expect(settings.get().country).toBeNull();
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      expect(settings.get().country).toBe("IT");
      expect(events).toContainEqual({ type: "settings.updated" });
      settings.update({ country: "DE" });
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      expect(settings.get().country).toBe("DE");
    });

    it("rejects a bank that is not in the list", async () => {
      const error = await rejection(
        service.start({ aspspName: "Banca Inesistente", aspspCountry: "IT" }),
      );
      expect(error).toMatchObject({ status: 404, code: "unknown_bank" });
      expect(bank.startCalls).toEqual([]);
      expect(authRequestCount()).toBe(0);
    });

    it("maps Enable Banking errors to 502 and passes configuration codes through", async () => {
      bank.startError = ebError(400, "REDIRECT_URI_NOT_ALLOWED", "Redirect URI not allowed");
      const misconfigured = await rejection(
        service.start({ aspspName: BANK_NAME, aspspCountry: "IT" }),
      );
      expect(misconfigured).toMatchObject({ status: 502, code: "REDIRECT_URI_NOT_ALLOWED" });
      expect(misconfigured.message).not.toContain("test-state");

      bank.startError = ebError(500, "ASPSP_ERROR", "ASPSP error");
      expect(
        await rejection(service.start({ aspspName: BANK_NAME, aspspCountry: "IT" })),
      ).toMatchObject({ status: 502, code: "bank_error" });

      bank.startError = null;
      bank.listError = ebError(503, "ASPSP_TIMEOUT", "ASPSP timeout");
      service = makeService(); // a fresh ASPSP cache, so the list is fetched again
      expect(
        await rejection(service.start({ aspspName: BANK_NAME, aspspCountry: "IT" })),
      ).toMatchObject({ status: 502, code: "bank_error" });
      expect(authRequestCount()).toBe(0);
    });

    it("only sends the owner to an https consent page or back to the panel", async () => {
      for (const url of ["javascript:alert(1)", "http://bank.example.test/consent", "not a url"]) {
        bank.authUrl = url;
        expect(
          await rejection(service.start({ aspspName: BANK_NAME, aspspCountry: "IT" })),
        ).toMatchObject({ status: 502, code: "bank_error" });
      }
      expect(authRequestCount()).toBe(0);

      const local = makeService({ publicUrl: new URL("http://127.0.0.1:8080") });
      bank.authUrl = "http://127.0.0.1:8080/api/banks/callback?state=s&code=fake-1";
      expect(await local.start({ aspspName: BANK_NAME, aspspCountry: "IT" })).toEqual({
        redirectUrl: bank.authUrl,
      });
    });

    it("refuses a bank whose maximum consent is not longer than the safety margin", async () => {
      bank.aspspList = [aspspFixture({ maximum_consent_validity: 600 })];
      expect(
        await rejection(service.start({ aspspName: BANK_NAME, aspspCountry: "IT" })),
      ).toMatchObject({ status: 502, code: "bank_error" });
      expect(bank.startCalls).toEqual([]);
    });
  });

  describe("renew", () => {
    it("starts a renewal with the bank of the connection", async () => {
      const connectionId = connectionIdOf(await connect([accountResource("current")]));
      expect(await service.renew(connectionId, { consentDays: 90 })).toEqual({
        redirectUrl: AUTH_URL,
      });
      expect(bank.startCalls.at(-1)).toMatchObject({
        aspsp: { name: BANK_NAME, country: "IT" },
        access: { valid_until: "2027-02-07T09:50:00.000+00:00" },
      });
      expect(
        t.sqlite
          .prepare("SELECT purpose, connection_id FROM bank_auth_requests WHERE state_hash = ?")
          .get(sha256(bank.lastState())),
      ).toEqual({ purpose: "renew", connection_id: connectionId });
    });

    it("rejects an unknown connection, a vanished bank and a removed connection", async () => {
      expect(await rejection(service.renew(999, {}))).toMatchObject({
        status: 404,
        code: "not_found",
      });
      const connectionId = connectionIdOf(await connect([accountResource("current")]));
      bank.aspspList = [aspspFixture({ name: OTHER_BANK_NAME })];
      service = makeService();
      expect(await rejection(service.renew(connectionId, {}))).toMatchObject({
        status: 404,
        code: "unknown_bank",
      });
      repo.updateConnection(connectionId, { removedAt: now });
      expect(await rejection(service.renew(connectionId, {}))).toMatchObject({
        status: 409,
        code: "connection_removed",
      });
    });
  });

  describe("complete", () => {
    it("accepts each state once and only within 30 minutes", async () => {
      expect(
        await rejection(service.complete({ state: "never-issued-state-0000", code: "code-x" })),
      ).toMatchObject({ status: 410, code: "state_invalid" });

      const first = await connect([accountResource("current")]);
      expect(first.outcome).toBe("connected");
      expect(
        await rejection(service.complete({ state: bank.lastState(), code: "code-1" })),
      ).toMatchObject({ status: 410, code: "state_invalid" });

      bank.willReturn("code-2", sessionFixture(2, [accountResource("savings")]));
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      now += AUTH_REQUEST_TTL_MS;
      expect(
        await rejection(service.complete({ state: bank.lastState(), code: "code-2" })),
      ).toMatchObject({ status: 410, code: "state_invalid" });
      expect(bank.exchangedCodes).toEqual(["code-1"]);
    });

    it("accepts a state just before it expires", async () => {
      bank.willReturn("code-1", sessionFixture(1, [accountResource("current")]));
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      now += AUTH_REQUEST_TTL_MS - 1;
      const result = await service.complete({ state: bank.lastState(), code: "code-1" });
      expect(result.outcome).toBe("connected");
    });

    it("requires a code or an error and leaves the state usable", async () => {
      bank.willReturn("code-1", sessionFixture(1, [accountResource("current")]));
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      const state = bank.lastState();
      expect(await rejection(service.complete({ state }))).toMatchObject({
        status: 400,
        code: "invalid_request",
      });
      expect(await rejection(service.complete({ state, code: "", error: "" }))).toMatchObject({
        status: 400,
        code: "invalid_request",
      });
      expect((await service.complete({ state, code: "code-1" })).outcome).toBe("connected");
    });

    it("reports a consent the owner cancelled at the bank", async () => {
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      const state = bank.lastState();
      const result = await service.complete({
        state,
        error: "access_denied",
        errorDescription: "Cancelled by user",
      });
      expect(result).toEqual({
        outcome: "denied",
        connectionId: null,
        bankName: BANK_NAME,
        accounts: [],
        errorCode: null,
      });
      expect(bank.exchangedCodes).toEqual([]);
      expect(await rejection(service.complete({ state, code: "code-1" }))).toMatchObject({
        status: 410,
      });
    });

    it("reports a bank-side failure of a renewal with its error code", async () => {
      const connectionId = connectionIdOf(await connect([accountResource("current")]));
      await service.renew(connectionId, {});
      const result = await service.complete({ state: bank.lastState(), error: "server_error" });
      expect(result).toEqual({
        outcome: "failed",
        connectionId,
        bankName: BANK_NAME,
        accounts: [],
        errorCode: "server_error",
      });
    });

    it("reports a failed code exchange with the Enable Banking code", async () => {
      bank.createSessionError = ebError(400, "EXPIRED_AUTHORIZATION_CODE", "Code expired");
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      expect(await service.complete({ state: bank.lastState(), code: "code-1" })).toEqual({
        outcome: "failed",
        connectionId: null,
        bankName: BANK_NAME,
        accounts: [],
        errorCode: "EXPIRED_AUTHORIZATION_CODE",
      });

      bank.createSessionError = parseEbErrorBody(502, "Bad gateway");
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      expect((await service.complete({ state: bank.lastState(), code: "code-1" })).errorCode).toBe(
        "bank_error",
      );

      bank.createSessionError = ebError(403, "NO_ACCOUNTS_ADDED", "No allowed accounts added");
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      expect((await service.complete({ state: bank.lastState(), code: "code-1" })).outcome).toBe(
        "no_accounts",
      );

      bank.createSessionError = new Error("Unexpected failure");
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT" });
      await expect(service.complete({ state: bank.lastState(), code: "code-1" })).rejects.toThrow(
        "Unexpected failure",
      );
      expect(repo.listConnections({ includeRemoved: true })).toEqual([]);
    });

    it("closes a session without accounts and reports no_accounts", async () => {
      const result = await connect([]);
      expect(result).toEqual({
        outcome: "no_accounts",
        connectionId: null,
        bankName: BANK_NAME,
        accounts: [],
        errorCode: null,
      });
      expect(bank.deletedSessions).toEqual([testSessionId(1)]);
      expect(repo.listConnections({ includeRemoved: true })).toEqual([]);
      expect(jobs()).toEqual([]);
    });

    it("queues the deletion when closing an empty session fails", async () => {
      bank.deleteSessionError = ebError(500, "ASPSP_TIMEOUT", "ASPSP timeout");
      expect((await connect([])).outcome).toBe("no_accounts");
      expect(jobs()).toEqual([
        {
          type: DELETE_SESSION_JOB,
          payload: { providerSessionId: testSessionId(1) },
          dedupeKey: null,
          status: "queued",
        },
      ]);
    });

    it("leaves a renewed connection unchanged when the bank shares no account", async () => {
      const connectionId = connectionIdOf(await connect([accountResource("current")]));
      finishJobs();
      const before = repo.getConnection(connectionId);
      const result = await renew(connectionId, [], 2);
      expect(result).toEqual({
        outcome: "no_accounts",
        connectionId,
        bankName: BANK_NAME,
        accounts: [],
        errorCode: null,
      });
      expect(repo.getConnection(connectionId)).toEqual(before);
      expect(bank.deletedSessions).toEqual([testSessionId(2)]);
      expect(queuedOf(DELETE_SESSION_JOB)).toEqual([]);
    });

    it("creates the connection and its accounts and queues the initial sync", async () => {
      const result = await connect([accountResource("current"), accountResource("card")]);
      const connectionId = connectionIdOf(result);
      const currentId = accountIdAt(result, 0);
      const cardId = accountIdAt(result, 1);
      expect(result).toEqual({
        outcome: "connected",
        connectionId,
        bankName: BANK_NAME,
        errorCode: null,
        accounts: [
          {
            id: currentId,
            name: "Conto Corrente Esempio",
            maskedIdentifier: "IT89 •••• •••• 1001",
            currency: "EUR",
            status: "active",
          },
          {
            id: cardId,
            name: "Carta Esempio",
            maskedIdentifier: "•••• 5678",
            currency: "EUR",
            status: "unavailable",
          },
        ],
      });
      expect(repo.getConnection(connectionId)).toMatchObject({
        aspspName: BANK_NAME,
        aspspCountry: "IT",
        aspspLogoUrl: "https://logos.example.test/banca-esempio.png",
        psuType: "personal",
        providerSessionId: testSessionId(1),
        status: "active",
        validUntil: Date.parse("2027-05-08T09:50:00.000Z"),
        createdAt: START,
        renewedAt: null,
        removedAt: null,
      });
      expect(repo.getAccount(currentId)).toMatchObject({
        connectionId,
        providerAccountUid: testUid(1),
        identificationHash: HASH_CURRENT,
        iban: IBAN_CURRENT,
        maskedIdentifier: "IT89 •••• •••• 1001",
        last4: "1001",
        product: "Conto Corrente Esempio",
        currency: "EUR",
        cashAccountType: "CACC",
        nickname: null,
        status: "active",
      });
      expect(repo.getAccount(cardId)).toMatchObject({
        providerAccountUid: null,
        iban: null,
        last4: "5678",
        status: "unavailable",
      });
      expect(JSON.stringify(repo.listAccounts({ connectionId }))).not.toContain("Alex Example");
      expect(queuedOf(SYNC_ACCOUNT_JOB)).toEqual([
        {
          type: SYNC_ACCOUNT_JOB,
          payload: { accountId: currentId, trigger: "initial" },
          dedupeKey: `sync:${currentId}`,
          status: "queued",
        },
      ]);
      expect(auditRows()).toEqual([
        {
          actor: "user",
          action: "connection.create",
          target: `connection:${connectionId}`,
          details: { accounts: 2, reattached: 0, syncsQueued: 1 },
        },
      ]);
      expect(events).toContainEqual({ type: "connection.updated", connectionId, status: "active" });
    });

    it("falls back to the requested end date when the session's is not parsable", async () => {
      bank.willReturn(
        "code-1",
        sessionFixture(1, [accountResource("current")], { validUntil: "soon" }),
      );
      await service.start({ aspspName: BANK_NAME, aspspCountry: "IT", consentDays: 30 });
      const result = await service.complete({ state: bank.lastState(), code: "code-1" });
      expect(repo.getConnection(connectionIdOf(result))?.validUntil).toBe(
        Date.parse("2026-12-09T09:50:00.000Z"),
      );
    });

    it("turns a connect for known accounts into a renewal of their connection", async () => {
      const first = await connect([accountResource("current"), accountResource("savings")]);
      const connectionId = connectionIdOf(first);
      const currentId = accountIdAt(first, 0);
      const savingsId = accountIdAt(first, 1);
      insertTransaction(currentId);
      finishJobs();
      now += HOUR_MS;

      const second = await connect(
        [
          accountResource("current", { uid: testUid(11) }),
          accountResource("savings", { uid: testUid(12) }),
        ],
        2,
      );
      expect(second).toMatchObject({ outcome: "renewed", connectionId, errorCode: null });
      expect(idsOf(second)).toEqual([currentId, savingsId]);
      expect(repo.listConnections()).toHaveLength(1);
      expect(repo.getConnection(connectionId)).toMatchObject({
        providerSessionId: testSessionId(2),
        renewedAt: START + HOUR_MS,
        status: "active",
      });
      expect(repo.getAccount(currentId)?.providerAccountUid).toBe(testUid(11));
      expect(repo.getAccount(savingsId)?.providerAccountUid).toBe(testUid(12));
      expect(queuedOf(DELETE_SESSION_JOB).map((job) => job.payload)).toEqual([
        { providerSessionId: testSessionId(1) },
      ]);
      expect(queuedOf(SYNC_ACCOUNT_JOB).map((job) => job.payload)).toEqual([
        { accountId: currentId, trigger: "renewal" },
        { accountId: savingsId, trigger: "initial" },
      ]);
      expect(auditRows().at(-1)).toEqual({
        actor: "user",
        action: "connection.renew",
        target: `connection:${connectionId}`,
        details: { matched: 2, created: 0, reattached: 0, missing: 0, syncsQueued: 2 },
      });
    });

    it("only renews connections of the same bank", async () => {
      const other = await connect([accountResource("current")], 1, OTHER_BANK_NAME);
      const same = await connect([accountResource("current", { uid: testUid(11) })], 2);
      expect(same.outcome).toBe("connected");
      expect(same.connectionId).not.toBe(other.connectionId);
      expect(repo.listConnections()).toHaveLength(2);
    });

    it("re-attaches a removed account to the new connection and keeps its history", async () => {
      const first = await connect([accountResource("current")]);
      const oldConnectionId = connectionIdOf(first);
      const accountId = accountIdAt(first, 0);
      insertTransaction(accountId);
      repo.updateConnection(oldConnectionId, { removedAt: now });
      repo.updateAccount(accountId, {
        status: "removed",
        removedAt: now,
        providerAccountUid: null,
      });
      finishJobs();
      now += 24 * HOUR_MS;

      const second = await connect([accountResource("current", { uid: testUid(11) })], 2);
      const newConnectionId = connectionIdOf(second);
      expect(second.outcome).toBe("connected");
      expect(newConnectionId).not.toBe(oldConnectionId);
      expect(idsOf(second)).toEqual([accountId]);
      expect(repo.getAccount(accountId)).toMatchObject({
        connectionId: newConnectionId,
        status: "active",
        removedAt: null,
        providerAccountUid: testUid(11),
      });
      expect(repo.countTransactions(accountId).total).toBe(1);
      expect(queuedOf(SYNC_ACCOUNT_JOB).map((job) => job.payload)).toEqual([
        { accountId, trigger: "renewal" },
      ]);
      expect(auditRows().at(-1)?.details).toEqual({ accounts: 1, reattached: 1, syncsQueued: 1 });
    });

    it("connects anew when the connection being renewed was removed meanwhile", async () => {
      const first = await connect([accountResource("current")]);
      const connectionId = connectionIdOf(first);
      const accountId = accountIdAt(first, 0);
      finishJobs();
      bank.willReturn(
        "code-2",
        sessionFixture(2, [accountResource("current", { uid: testUid(11) })]),
      );
      await service.renew(connectionId, {});
      repo.updateConnection(connectionId, { removedAt: now });
      repo.updateAccount(accountId, { status: "removed", removedAt: now });

      const result = await service.complete({ state: bank.lastState(), code: "code-2" });
      expect(result.outcome).toBe("connected");
      expect(result.connectionId).not.toBe(connectionId);
      expect(idsOf(result)).toEqual([accountId]);
    });

    it("maps renewed accounts by hash, alternate hash and IBAN", async () => {
      const first = await connect([
        accountResource("current"),
        accountResource("savings"),
        accountResource("usd"),
      ]);
      const connectionId = connectionIdOf(first);
      const currentId = accountIdAt(first, 0);
      const savingsId = accountIdAt(first, 1);
      const usdId = accountIdAt(first, 2);
      repo.updateConnection(connectionId, {
        status: "expired",
        lastErrorCode: "EXPIRED_SESSION",
        lastErrorMessage: "Session expired",
        lastErrorAt: now,
      });
      insertTransaction(currentId);
      finishJobs();
      now += HOUR_MS;

      const result = await renew(
        connectionId,
        [
          accountResource("current", { uid: testUid(11) }),
          accountResource("savings", {
            uid: testUid(12),
            identification_hash: "hash-savings-v2",
            identification_hashes: ["hash-savings-v2", HASH_SAVINGS],
          }),
          accountResource("usd", {
            uid: testUid(13),
            identification_hash: "hash-usd-v2",
            identification_hashes: ["hash-usd-v2"],
          }),
        ],
        2,
      );
      expect(result).toMatchObject({ outcome: "renewed", connectionId });
      expect(idsOf(result)).toEqual([currentId, savingsId, usdId]);
      expect(repo.getAccount(savingsId)).toMatchObject({
        providerAccountUid: testUid(12),
        identificationHash: "hash-savings-v2",
        status: "active",
      });
      expect(repo.getAccount(usdId)).toMatchObject({
        providerAccountUid: testUid(13),
        identificationHash: "hash-usd-v2",
        iban: IBAN_USD,
        status: "active",
      });
      expect(repo.getConnection(connectionId)).toMatchObject({
        providerSessionId: testSessionId(2),
        status: "active",
        validUntil: Date.parse("2027-05-08T09:50:00.000Z"),
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        renewedAt: START + HOUR_MS,
      });
      expect(queuedOf(DELETE_SESSION_JOB).map((job) => job.payload)).toEqual([
        { providerSessionId: testSessionId(1) },
      ]);
      expect(queuedOf(SYNC_ACCOUNT_JOB).map((job) => job.payload)).toEqual([
        { accountId: currentId, trigger: "renewal" },
        { accountId: savingsId, trigger: "initial" },
        { accountId: usdId, trigger: "initial" },
      ]);
      expect(events.at(-1)).toEqual({ type: "connection.updated", connectionId, status: "active" });
      expect(auditRows().at(-1)?.details).toEqual({
        matched: 3,
        created: 0,
        reattached: 0,
        missing: 0,
        syncsQueued: 3,
      });
    });

    it("adds new accounts, marks missing ones unavailable and keeps disabled ones disabled", async () => {
      const first = await connect([
        accountResource("current"),
        accountResource("savings"),
        accountResource("usd"),
      ]);
      const connectionId = connectionIdOf(first);
      const currentId = accountIdAt(first, 0);
      const savingsId = accountIdAt(first, 1);
      const usdId = accountIdAt(first, 2);
      repo.updateAccount(savingsId, { status: "disabled" });
      repo.updateAccount(usdId, { status: "disabled" });
      finishJobs();

      const result = await renew(
        connectionId,
        [
          accountResource("savings", { uid: testUid(12) }),
          accountResource("card", { uid: testUid(14) }),
        ],
        2,
      );
      const cardId = accountIdAt(result, 1);
      expect(idsOf(result)).toEqual([savingsId, cardId]);
      expect(repo.getAccount(savingsId)).toMatchObject({
        status: "disabled",
        providerAccountUid: testUid(12),
      });
      expect(repo.getAccount(cardId)).toMatchObject({
        connectionId,
        status: "active",
        providerAccountUid: testUid(14),
        maskedIdentifier: "•••• 5678",
      });
      expect(repo.getAccount(currentId)).toMatchObject({
        status: "unavailable",
        providerAccountUid: null,
      });
      expect(repo.getAccount(usdId)).toMatchObject({
        status: "disabled",
        providerAccountUid: null,
      });
      expect(queuedOf(SYNC_ACCOUNT_JOB).map((job) => job.payload)).toEqual([
        { accountId: cardId, trigger: "initial" },
      ]);
      expect(auditRows().at(-1)?.details).toEqual({
        matched: 1,
        created: 1,
        reattached: 0,
        missing: 2,
        syncsQueued: 1,
      });
    });
  });
});
