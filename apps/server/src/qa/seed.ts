import { randomBytes } from "node:crypto";
import { OwnerStore } from "../auth/owner";
import { hashPassword } from "../auth/passwords";
import { SessionStore } from "../auth/sessions";
import { createTotpSetup } from "../auth/totp";
import { deriveKey } from "../crypto";
import type { SeedContext } from "../server";
import { QA_SEEDERS } from "./seeders";

/**
 * Prepares a fresh QA database. With `owner`, it creates the owner with a random password and a
 * random TOTP secret that nobody needs to know, and opens a session whose raw token the QA
 * harness puts in its browser cookie. Then it runs every registered seeder once.
 */
export async function seedQa(
  ctx: SeedContext,
  options: { owner: boolean },
): Promise<{ sessionToken: string | null }> {
  let sessionToken: string | null = null;
  if (options.owner) {
    const owners = new OwnerStore(ctx.db, deriveKey(ctx.config.masterKey, "totp"));
    const { secret } = createTotpSetup("qa");
    owners.create(
      {
        passwordHash: await hashPassword(randomBytes(24).toString("base64url")),
        totpSecret: secret,
        lastTotpStep: 0,
      },
      new Date(ctx.now()),
    );
    sessionToken = new SessionStore(ctx.db, ctx.now).create("qa");
  }
  for (const seeder of QA_SEEDERS) seeder(ctx);
  return { sessionToken };
}
