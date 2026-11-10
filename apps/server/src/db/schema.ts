import { sql } from "drizzle-orm";
import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const owner = sqliteTable("owner", {
  id: integer("id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEnc: blob("totp_secret_enc", { mode: "buffer" }).notNull(),
  lastTotpStep: integer("last_totp_step").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const authSessions = sqliteTable("auth_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  userAgent: text("user_agent"),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: integer("run_after").notNull(),
    lockedAt: integer("locked_at"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    dedupeKey: text("dedupe_key"),
  },
  (table) => [
    index("jobs_claim_idx").on(table.status, table.runAfter),
    uniqueIndex("jobs_dedupe_active_uq")
      .on(table.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL AND status IN ('queued', 'running')`),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const bankConnections = sqliteTable(
  "bank_connections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    aspspName: text("aspsp_name").notNull(),
    aspspCountry: text("aspsp_country").notNull(),
    aspspLogoUrl: text("aspsp_logo_url"),
    psuType: text("psu_type").notNull().default("personal"),
    providerSessionId: text("provider_session_id").notNull(),
    status: text("status", { enum: ["active", "expired", "revoked", "error"] })
      .notNull()
      .default("active"),
    validUntil: integer("valid_until").notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorAt: integer("last_error_at"),
    statusCheckedAt: integer("status_checked_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    renewedAt: integer("renewed_at"),
    removedAt: integer("removed_at"),
  },
  (table) => [index("bank_connections_status_idx").on(table.status)],
);

export const bankAuthRequests = sqliteTable("bank_auth_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stateHash: text("state_hash").notNull().unique(),
  purpose: text("purpose", { enum: ["connect", "renew"] }).notNull(),
  connectionId: integer("connection_id").references(() => bankConnections.id, {
    onDelete: "cascade",
  }),
  aspspName: text("aspsp_name").notNull(),
  aspspCountry: text("aspsp_country").notNull(),
  validUntil: integer("valid_until").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => bankConnections.id),
    providerAccountUid: text("provider_account_uid"),
    identificationHash: text("identification_hash").notNull(),
    iban: text("iban"),
    maskedIdentifier: text("masked_identifier"),
    last4: text("last4"),
    product: text("product"),
    details: text("details"),
    nickname: text("nickname"),
    currency: text("currency").notNull(),
    cashAccountType: text("cash_account_type"),
    status: text("status", { enum: ["active", "disabled", "unavailable", "removed"] })
      .notNull()
      .default("active"),
    lastSyncedAt: integer("last_synced_at"),
    lastSyncErrorCode: text("last_sync_error_code"),
    lastSyncErrorAt: integer("last_sync_error_at"),
    rateLimitedUntil: integer("rate_limited_until"),
    bgFetchDay: text("bg_fetch_day"),
    bgFetchCount: integer("bg_fetch_count").notNull().default(0),
    lastScheduledSyncDay: text("last_scheduled_sync_day"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    removedAt: integer("removed_at"),
  },
  (table) => [
    index("accounts_connection_idx").on(table.connectionId),
    index("accounts_identification_idx").on(table.identificationHash),
  ],
);

export const balances = sqliteTable(
  "balances",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    balanceType: text("balance_type").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    referenceDate: text("reference_date").notNull(),
    asOf: integer("as_of").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (table) => [
    uniqueIndex("balances_account_type_day_uq").on(
      table.accountId,
      table.balanceType,
      table.referenceDate,
    ),
  ],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    providerReference: text("provider_reference"),
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: ["booked", "pending"] }).notNull(),
    bookingDate: text("booking_date"),
    valueDate: text("value_date"),
    transactionDate: text("transaction_date"),
    sortDate: text("sort_date").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    counterparty: text("counterparty"),
    counterpartyAccount: text("counterparty_account"),
    remittance: text("remittance"),
    bankCode: text("bank_code"),
    merchantCategoryCode: text("merchant_category_code"),
    balanceAfterMinor: integer("balance_after_minor"),
    searchText: text("search_text").notNull(),
    rawJson: text("raw_json").notNull(),
    missingCount: integer("missing_count").notNull().default(0),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("transactions_account_fingerprint_uq").on(table.accountId, table.fingerprint),
    index("transactions_account_reference_idx").on(table.accountId, table.providerReference),
    index("transactions_account_date_idx").on(table.accountId, table.sortDate),
    index("transactions_date_idx").on(table.sortDate),
  ],
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: ["initial", "manual", "background", "renewal"] }).notNull(),
    status: text("status", { enum: ["running", "succeeded", "failed", "skipped"] }).notNull(),
    skipReason: text("skip_reason", {
      enum: [
        "rate_limited",
        "daily_cap",
        "connection_inactive",
        "account_inactive",
        "no_provider_uid",
      ],
    }),
    withPsuHeaders: integer("with_psu_headers", { mode: "boolean" }).notNull().default(false),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    fetched: integer("fetched").notNull().default(0),
    inserted: integer("inserted").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    removed: integer("removed").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [index("sync_runs_account_idx").on(table.accountId, table.startedAt)],
);

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  event: text("event", {
    enum: [
      "consent_expiring",
      "consent_expired",
      "connection_error",
      "sync_failing",
      "backup_failing",
    ],
  }).notNull(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  params: text("params").notNull(),
  link: text("link"),
  createdAt: integer("created_at").notNull(),
  readAt: integer("read_at"),
  emailStatus: text("email_status", { enum: ["skipped", "pending", "sent", "failed"] }).notNull(),
  emailSentAt: integer("email_sent_at"),
  emailError: text("email_error"),
});

export const backupRuns = sqliteTable("backup_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  setId: text("set_id"),
  trigger: text("trigger", { enum: ["scheduled", "manual", "cli"] }).notNull(),
  status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull(),
  target: text("target", { enum: ["local", "s3"] }).notNull(),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  sizeBytes: integer("size_bytes"),
  errorMessage: text("error_message"),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actor: text("actor", { enum: ["user", "system"] }).notNull(),
    action: text("action").notNull(),
    target: text("target"),
    details: text("details"),
    at: integer("at").notNull(),
  },
  (table) => [index("audit_log_at_idx").on(table.at)],
);
