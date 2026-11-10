import { createHash, randomBytes } from "node:crypto";
import {
  type AccountStatus,
  accountDisplayName,
  type CompleteConnectionRequest,
  type CompleteConnectionResponse,
  type ConnectedAccount,
  type ConnectOutcome,
  effectiveConnectionStatus,
  type RenewConnectionRequest,
  type StartConnectionRequest,
  type StartConnectionResponse,
  type SyncTrigger,
} from "@bursar/shared";
import type { AuditLog } from "../audit";
import type { AspspCache } from "../eb/aspsp-cache";
import type { EnableBankingApi } from "../eb/client";
import { EnableBankingError } from "../eb/errors";
import type {
  EbAccountResource,
  EbAspsp,
  EbSession,
  EbStartAuthorizationResponse,
} from "../eb/schemas";
import type { EventBus } from "../events/bus";
import type { JobQueue } from "../jobs/queue";
import {
  DELETE_SESSION_JOB,
  deleteSessionPayloadSchema,
  SYNC_ACCOUNT_JOB,
  syncAccountPayloadSchema,
  syncDedupeKey,
} from "../jobs/types";
import type { SettingsStore } from "../settings/store";
import {
  type AccountFields,
  accountFieldsFromResource,
  type MappableAccount,
  mapAccounts,
} from "./account-mapping";
import type { AccountRow, AuthRequestRow, ConnectionRow, FinanceRepository } from "./repository";

/** How long the owner has to finish the consent at the bank (spec §6.3). */
export const AUTH_REQUEST_TTL_MS = 30 * 60_000;
/** Subtracted from the consent end so a slow clock or bank never pushes it past the maximum. */
export const CONSENT_SAFETY_MARGIN_MS = 10 * 60_000;

const DAY_MS = 86_400_000;
const CALLBACK_PATH = "/api/banks/callback";
/** Enable Banking codes the panel explains with a Control Panel fix; others become `bank_error`. */
const FORWARDED_EB_CODES: ReadonlySet<string> = new Set([
  "REDIRECT_URI_NOT_ALLOWED",
  "WRONG_ASPSP_PROVIDED",
]);

export type ConnectErrorStatus = 400 | 404 | 409 | 410 | 502 | 503;

export class ConnectError extends Error {
  constructor(
    readonly status: ConnectErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

export interface ConnectServiceDeps {
  repo: FinanceRepository;
  api: EnableBankingApi;
  aspsps: AspspCache;
  queue: JobQueue;
  bus: EventBus;
  audit: AuditLog;
  settings: SettingsStore;
  publicUrl: URL;
  timezone: string;
  now?: () => number;
  /** Test hook; the default is 32 random bytes in base64url. */
  randomState?: () => string;
}

type CallbackResult = { kind: "error"; error: string } | { kind: "code"; code: string };

interface Applied {
  outcome: "connected" | "renewed";
  connectionId: number;
  accountIds: number[];
}

interface Attached {
  ids: Map<EbAccountResource, number>;
  created: number;
  reattached: number;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** RFC 3339 with an explicit `+00:00` offset, as `POST /auth` documents it. */
function formatValidUntil(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/Z$/, "+00:00");
}

function parseValidUntil(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function callbackResult(input: CompleteConnectionRequest): CallbackResult | null {
  if (input.error) return { kind: "error", error: input.error };
  if (input.code) return { kind: "code", code: input.code };
  return null;
}

function toMappable(account: AccountRow): MappableAccount {
  return {
    id: account.id,
    identificationHash: account.identificationHash,
    iban: account.iban,
    status: account.status,
  };
}

/** An account the bank gives no `uid` for cannot be fetched (blocked or closed). */
function statusFor(fields: AccountFields): AccountStatus {
  return fields.providerAccountUid === null ? "unavailable" : "active";
}

function orderedIds(
  resources: readonly EbAccountResource[],
  ids: ReadonlyMap<EbAccountResource, number>,
): number[] {
  return resources.flatMap((resource) => {
    const id = ids.get(resource);
    return id === undefined ? [] : [id];
  });
}

/** Enable Banking failures become a 502; anything else is a bug and propagates unchanged. */
function bankFailure(error: unknown): unknown {
  if (!(error instanceof EnableBankingError)) return error;
  const code =
    error.code !== null && FORWARDED_EB_CODES.has(error.code) ? error.code : "bank_error";
  return new ConnectError(502, code, "The bank service rejected the request");
}

/**
 * Connect and consent renewal (spec §6.3). `start` and `renew` ask Enable Banking for the bank's
 * consent page with a single-use `state` stored only as a hash. `complete` runs from the panel's
 * callback page on an authenticated, Origin-checked POST (the bank's redirect carries no
 * `SameSite=Strict` cookie), exchanges the code and stores the connection and its accounts.
 */
export class ConnectService {
  private readonly now: () => number;
  private readonly randomState: () => string;

  constructor(private readonly deps: ConnectServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.randomState = deps.randomState ?? (() => randomBytes(32).toString("base64url"));
  }

  async start(input: StartConnectionRequest): Promise<StartConnectionResponse> {
    const aspsp = await this.findAspsp(input.aspspCountry, input.aspspName);
    const response = await this.authorize(aspsp, "connect", null, input.consentDays);
    if (this.deps.settings.get().country === null) {
      this.deps.settings.update({ country: aspsp.country });
      this.deps.bus.publish({ type: "settings.updated" });
    }
    return response;
  }

  async renew(
    connectionId: number,
    input: RenewConnectionRequest,
  ): Promise<StartConnectionResponse> {
    const connection = this.deps.repo.getConnection(connectionId);
    if (!connection) throw new ConnectError(404, "not_found", "Connection not found");
    if (connection.removedAt !== null) {
      throw new ConnectError(409, "connection_removed", "The connection was removed");
    }
    const aspsp = await this.findAspsp(connection.aspspCountry, connection.aspspName);
    return this.authorize(aspsp, "renew", connection.id, input.consentDays);
  }

  async complete(input: CompleteConnectionRequest): Promise<CompleteConnectionResponse> {
    const result = callbackResult(input);
    if (!result) throw new ConnectError(400, "invalid_request", "Invalid request");
    const request = this.deps.repo.consumeAuthRequest(sha256Hex(input.state));
    if (!request) {
      throw new ConnectError(
        410,
        "state_invalid",
        "The authorisation has expired or was already used",
      );
    }
    if (result.kind === "error") {
      return result.error === "access_denied"
        ? this.unconnected(request, "denied", null)
        : this.unconnected(request, "failed", result.error);
    }

    let session: EbSession;
    try {
      session = await this.deps.api.createSession(result.code);
    } catch (error) {
      if (!(error instanceof EnableBankingError)) throw error;
      if (error.code === "NO_ACCOUNTS_ADDED") return this.unconnected(request, "no_accounts", null);
      return this.unconnected(request, "failed", error.code ?? "bank_error");
    }
    if (session.accounts.length === 0) {
      await this.closeSession(session.session_id);
      return this.unconnected(request, "no_accounts", null);
    }

    const validUntil = parseValidUntil(session.access.valid_until) ?? request.validUntil;
    const logoUrl = await this.logoUrl(request);
    // From here on everything is synchronous, so no other completion can interleave.
    const now = this.now();
    const target = this.renewalTarget(request, session.accounts);
    const applied = this.deps.repo.transaction(() =>
      target
        ? this.applyRenewal(target, session, validUntil, logoUrl, now)
        : this.applyNewConnection(request, session, validUntil, logoUrl, now),
    );
    this.deps.bus.publish({
      type: "connection.updated",
      connectionId: applied.connectionId,
      status: effectiveConnectionStatus("active", validUntil, now, this.deps.timezone),
    });
    return {
      outcome: applied.outcome,
      connectionId: applied.connectionId,
      bankName: request.aspspName,
      accounts: this.describe(applied.accountIds),
      errorCode: null,
    };
  }

  private async findAspsp(country: string, name: string): Promise<EbAspsp> {
    let aspsp: EbAspsp | null;
    try {
      aspsp = await this.deps.aspsps.find(country, name);
    } catch (error) {
      throw bankFailure(error);
    }
    if (!aspsp) throw new ConnectError(404, "unknown_bank", "Unknown bank");
    return aspsp;
  }

  private async authorize(
    aspsp: EbAspsp,
    purpose: "connect" | "renew",
    connectionId: number | null,
    consentDays: number | undefined,
  ): Promise<StartConnectionResponse> {
    const now = this.now();
    const settings = this.deps.settings.get();
    const consentMs = Math.min(
      aspsp.maximum_consent_validity * 1000,
      (consentDays ?? settings.consentDays) * DAY_MS,
    );
    if (consentMs <= CONSENT_SAFETY_MARGIN_MS) {
      throw new ConnectError(502, "bank_error", "The bank allows no usable consent period");
    }
    const validUntil = now + consentMs - CONSENT_SAFETY_MARGIN_MS;
    const state = this.randomState();
    let authorization: EbStartAuthorizationResponse;
    try {
      authorization = await this.deps.api.startAuthorization({
        access: { valid_until: formatValidUntil(validUntil), balances: true, transactions: true },
        aspsp: { name: aspsp.name, country: aspsp.country },
        state,
        redirect_url: new URL(CALLBACK_PATH, this.deps.publicUrl).toString(),
        psu_type: "personal",
        language: settings.locale,
      });
    } catch (error) {
      throw bankFailure(error);
    }
    if (!this.isAllowedConsentPage(authorization.url)) {
      throw new ConnectError(
        502,
        "bank_error",
        "The bank service returned an unusable consent page",
      );
    }
    this.deps.repo.createAuthRequest({
      stateHash: sha256Hex(state),
      purpose,
      connectionId,
      aspspName: aspsp.name,
      aspspCountry: aspsp.country,
      validUntil,
      expiresAt: now + AUTH_REQUEST_TTL_MS,
    });
    return { redirectUrl: authorization.url };
  }

  /** The panel navigates to this URL: https only, or back to the panel itself (the local fake bank). */
  private isAllowedConsentPage(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.origin === this.deps.publicUrl.origin;
    } catch {
      return false;
    }
  }

  private unconnected(
    request: AuthRequestRow,
    outcome: Exclude<ConnectOutcome, "connected" | "renewed">,
    errorCode: string | null,
  ): CompleteConnectionResponse {
    return {
      outcome,
      connectionId: request.purpose === "renew" ? request.connectionId : null,
      bankName: request.aspspName,
      accounts: [],
      errorCode,
    };
  }

  /** Best effort: a session without accounts must not linger at the bank (eb-api-notes §10). */
  private async closeSession(providerSessionId: string): Promise<void> {
    try {
      await this.deps.api.deleteSession(providerSessionId);
    } catch {
      this.deps.queue.enqueue(
        DELETE_SESSION_JOB,
        deleteSessionPayloadSchema.parse({ providerSessionId }),
      );
    }
  }

  private async logoUrl(request: AuthRequestRow): Promise<string | null> {
    try {
      return (await this.deps.aspsps.find(request.aspspCountry, request.aspspName))?.logo ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The connection this completion renews: the live connection a renewal was started for, else a
   * live connection of the same bank that already holds some of the returned accounts (the one
   * holding most of them, the newest on a tie). Null means a new connection.
   */
  private renewalTarget(
    request: AuthRequestRow,
    resources: readonly EbAccountResource[],
  ): ConnectionRow | null {
    if (request.purpose === "renew" && request.connectionId !== null) {
      const connection = this.deps.repo.getConnection(request.connectionId);
      if (connection && connection.removedAt === null) return connection;
    }
    let best: { connection: ConnectionRow; score: number } | null = null;
    for (const connection of this.deps.repo.listConnections({ includeRemoved: false })) {
      if (connection.removedAt !== null) continue;
      if (connection.aspspName !== request.aspspName) continue;
      if (connection.aspspCountry !== request.aspspCountry) continue;
      const accounts = this.deps.repo
        .listAccounts({ connectionId: connection.id })
        .filter((account) => account.status !== "removed");
      const score = mapAccounts(accounts.map(toMappable), resources).matched.length;
      if (score === 0) continue;
      if (
        !best ||
        score > best.score ||
        (score === best.score && connection.id > best.connection.id)
      ) {
        best = { connection, score };
      }
    }
    return best?.connection ?? null;
  }

  private applyNewConnection(
    request: AuthRequestRow,
    session: EbSession,
    validUntil: number,
    logoUrl: string | null,
    now: number,
  ): Applied {
    const connectionId = this.deps.repo.createConnection({
      aspspName: request.aspspName,
      aspspCountry: request.aspspCountry,
      aspspLogoUrl: logoUrl,
      psuType: "personal",
      providerSessionId: session.session_id,
      status: "active",
      validUntil,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      statusCheckedAt: now,
      renewedAt: null,
      removedAt: null,
    });
    const attached = this.attachAccounts(connectionId, session.accounts);
    const accountIds = orderedIds(session.accounts, attached.ids);
    const syncsQueued = this.enqueueSyncs(accountIds);
    this.deps.audit.record({
      actor: "user",
      action: "connection.create",
      target: `connection:${connectionId}`,
      details: { accounts: accountIds.length, reattached: attached.reattached, syncsQueued },
    });
    return { outcome: "connected", connectionId, accountIds };
  }

  private applyRenewal(
    connection: ConnectionRow,
    session: EbSession,
    validUntil: number,
    logoUrl: string | null,
    now: number,
  ): Applied {
    const { repo } = this.deps;
    const existing = repo.listAccounts({ connectionId: connection.id });
    const disabled = new Set(
      existing.filter((account) => account.status === "disabled").map((account) => account.id),
    );
    const mapping = mapAccounts(existing.map(toMappable), session.accounts);
    const ids = new Map<EbAccountResource, number>();
    for (const { accountId, resource } of mapping.matched) {
      const fields = accountFieldsFromResource(resource);
      repo.updateAccount(accountId, {
        ...fields,
        status: disabled.has(accountId) ? "disabled" : statusFor(fields),
        removedAt: null,
      });
      ids.set(resource, accountId);
    }
    const attached = this.attachAccounts(connection.id, mapping.created);
    for (const [resource, accountId] of attached.ids) ids.set(resource, accountId);
    for (const accountId of mapping.missing) {
      // The old uid died with the old session; a disabled account stays out of the totals.
      repo.updateAccount(accountId, {
        providerAccountUid: null,
        status: disabled.has(accountId) ? "disabled" : "unavailable",
      });
    }
    repo.updateConnection(connection.id, {
      providerSessionId: session.session_id,
      validUntil,
      status: "active",
      aspspLogoUrl: logoUrl ?? connection.aspspLogoUrl,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      statusCheckedAt: now,
      renewedAt: now,
    });
    if (connection.providerSessionId !== session.session_id) {
      // Closing the old consent never blocks the owner: the worker does it.
      this.deps.queue.enqueue(
        DELETE_SESSION_JOB,
        deleteSessionPayloadSchema.parse({ providerSessionId: connection.providerSessionId }),
      );
    }
    const accountIds = orderedIds(session.accounts, ids);
    const syncsQueued = this.enqueueSyncs(accountIds);
    this.deps.audit.record({
      actor: "user",
      action: "connection.renew",
      target: `connection:${connection.id}`,
      details: {
        matched: mapping.matched.length,
        created: attached.created,
        reattached: attached.reattached,
        missing: mapping.missing.length,
        syncsQueued,
      },
    });
    return { outcome: "renewed", connectionId: connection.id, accountIds };
  }

  /**
   * Adds bank accounts to a connection. An account that matches a `removed` account (disconnected
   * earlier, transactions not purged) re-attaches that row so its history is kept.
   */
  private attachAccounts(connectionId: number, resources: readonly EbAccountResource[]): Attached {
    const { repo } = this.deps;
    const candidates = new Map<number, AccountRow>();
    for (const resource of resources) {
      const fields = accountFieldsFromResource(resource);
      const hashes = [resource.identification_hash, ...resource.identification_hashes];
      for (const account of repo.findAccountsByIdentity(hashes, fields.iban)) {
        if (account.status === "removed") candidates.set(account.id, account);
      }
    }
    const mapping = mapAccounts([...candidates.values()].map(toMappable), resources);
    const ids = new Map<EbAccountResource, number>();
    for (const { accountId, resource } of mapping.matched) {
      const fields = accountFieldsFromResource(resource);
      repo.updateAccount(accountId, {
        ...fields,
        connectionId,
        status: statusFor(fields),
        removedAt: null,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
      });
      ids.set(resource, accountId);
    }
    for (const resource of mapping.created) {
      const fields = accountFieldsFromResource(resource);
      const accountId = repo.createAccount({
        connectionId,
        ...fields,
        nickname: null,
        status: statusFor(fields),
        lastSyncedAt: null,
        lastSyncErrorCode: null,
        lastSyncErrorAt: null,
        rateLimitedUntil: null,
        bgFetchDay: null,
        bgFetchCount: 0,
        lastScheduledSyncDay: null,
        removedAt: null,
      });
      ids.set(resource, accountId);
    }
    return { ids, created: mapping.created.length, reattached: mapping.matched.length };
  }

  /** One sync per active account: `initial` (longest history) while it has no transaction yet. */
  private enqueueSyncs(accountIds: readonly number[]): number {
    let queued = 0;
    for (const accountId of accountIds) {
      if (this.deps.repo.getAccount(accountId)?.status !== "active") continue;
      const trigger: SyncTrigger =
        this.deps.repo.countTransactions(accountId).total === 0 ? "initial" : "renewal";
      this.deps.queue.enqueueUnique(
        SYNC_ACCOUNT_JOB,
        syncDedupeKey(accountId),
        syncAccountPayloadSchema.parse({ accountId, trigger }),
      );
      queued += 1;
    }
    return queued;
  }

  private describe(accountIds: readonly number[]): ConnectedAccount[] {
    const { locale } = this.deps.settings.get();
    return accountIds.flatMap((accountId) => {
      const account = this.deps.repo.getAccount(accountId);
      if (!account) return [];
      return [
        {
          id: account.id,
          name: accountDisplayName(account, locale),
          maskedIdentifier: account.maskedIdentifier,
          currency: account.currency,
          status: account.status,
        },
      ];
    });
  }
}
