import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import type { BursarDb } from "../db";
import { authSessions } from "../db/schema";

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60_000;

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export class SessionStore {
  constructor(
    private readonly db: BursarDb,
    private readonly now: () => number = Date.now,
  ) {}

  create(userAgent: string | null): string {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db
      .insert(authSessions)
      .values({
        tokenHash: hashToken(token),
        createdAt: new Date(now),
        lastSeenAt: new Date(now),
        expiresAt: new Date(now + SESSION_IDLE_MS),
        userAgent: userAgent?.slice(0, 256) ?? null,
      })
      .run();
    return token;
  }

  validate(token: string): number | null {
    const now = this.now();
    const row = this.find(token, now);
    if (!row) return null;
    if (now - row.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      this.db
        .update(authSessions)
        .set({ lastSeenAt: new Date(now), expiresAt: new Date(now + SESSION_IDLE_MS) })
        .where(eq(authSessions.id, row.id))
        .run();
    }
    return row.id;
  }

  /**
   * Like `validate`, but never slides the expiry: long-lived readers (the SSE heartbeat) can ask
   * whether a session still exists without keeping it alive.
   */
  peek(token: string): number | null {
    return this.find(token, this.now())?.id ?? null;
  }

  revoke(token: string): void {
    this.db
      .delete(authSessions)
      .where(eq(authSessions.tokenHash, hashToken(token)))
      .run();
  }

  private find(token: string, now: number) {
    return this.db
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.tokenHash, hashToken(token)),
          gt(authSessions.expiresAt, new Date(now)),
        ),
      )
      .get();
  }

  purgeExpired(): number {
    return this.db
      .delete(authSessions)
      .where(lte(authSessions.expiresAt, new Date(this.now())))
      .run().changes;
  }
}
