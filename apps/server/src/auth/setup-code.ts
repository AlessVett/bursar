import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export class SetupCode {
  private code: string | null = null;

  constructor(private readonly filePath: string) {}

  issue(): void {
    this.code = randomBytes(18).toString("base64url");
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${this.code}\n`, { mode: 0o600 });
    chmodSync(this.filePath, 0o600);
  }

  verify(candidate: string): boolean {
    if (!this.code) return false;
    const given = Buffer.from(candidate.trim());
    const expected = Buffer.from(this.code);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  clear(): void {
    this.code = null;
    rmSync(this.filePath, { force: true });
  }
}
