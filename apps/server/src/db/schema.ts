import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  },
  (table) => [index("jobs_claim_idx").on(table.status, table.runAfter)],
);
