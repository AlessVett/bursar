import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type KeyPurpose = "database" | "totp" | "documents";

const FORMAT_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}

export function deriveKey(master: Buffer, purpose: KeyPurpose): Buffer {
  if (master.length !== 32) throw new Error("The master key must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `bursar:${purpose}:v1`, 32));
}

export function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, ciphertext, cipher.getAuthTag()]);
}

export function unseal(key: Buffer, sealed: Buffer): Buffer {
  if (sealed[0] !== FORMAT_VERSION) throw new Error("Unsupported sealed data version");
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error("Sealed data is truncated");
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ciphertext = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
