import { and, eq, lt } from "drizzle-orm";
import { seal, unseal } from "../crypto";
import type { BursarDb } from "../db";
import { owner } from "../db/schema";

const OWNER_ID = 1;

/** The TOTP step was already consumed, by an earlier or a concurrent login. */
export class TotpStepReusedError extends Error {
  constructor() {
    super("TOTP step already used");
    this.name = "TotpStepReusedError";
  }
}

export interface OwnerRecord {
  passwordHash: string;
  totpSecret: string;
  lastTotpStep: number;
}

export class OwnerStore {
  constructor(
    private readonly db: BursarDb,
    private readonly totpKey: Buffer,
  ) {}

  exists(): boolean {
    return this.db.select({ id: owner.id }).from(owner).get() !== undefined;
  }

  get(): OwnerRecord | null {
    const row = this.db.select().from(owner).where(eq(owner.id, OWNER_ID)).get();
    if (!row) return null;
    return {
      passwordHash: row.passwordHash,
      totpSecret: unseal(this.totpKey, row.totpSecretEnc).toString("utf8"),
      lastTotpStep: row.lastTotpStep,
    };
  }

  create(record: OwnerRecord, now: Date): void {
    this.db
      .insert(owner)
      .values({
        id: OWNER_ID,
        passwordHash: record.passwordHash,
        totpSecretEnc: seal(this.totpKey, Buffer.from(record.totpSecret, "utf8")),
        lastTotpStep: record.lastTotpStep,
        createdAt: now,
      })
      .run();
  }

  /**
   * Advances the last used TOTP step atomically and only forwards. Throws when
   * the step is not strictly greater than the stored one (replay or concurrent
   * login that already consumed it) or when no owner exists.
   */
  setLastTotpStep(step: number): void {
    const result = this.db
      .update(owner)
      .set({ lastTotpStep: step })
      .where(and(eq(owner.id, OWNER_ID), lt(owner.lastTotpStep, step)))
      .run();
    if (result.changes === 0) throw new TotpStepReusedError();
  }
}
