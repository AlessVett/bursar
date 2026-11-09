import { eq } from "drizzle-orm";
import { seal, unseal } from "../crypto";
import type { BursarDb } from "../db";
import { owner } from "../db/schema";

const OWNER_ID = 1;

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

  setLastTotpStep(step: number): void {
    this.db.update(owner).set({ lastTotpStep: step }).where(eq(owner.id, OWNER_ID)).run();
  }
}
