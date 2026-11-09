import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_PASSPHRASE, type TestDatabase } from "../test/db";
import { openDatabase } from "./index";
import { owner } from "./schema";

function fileHeader(file: string): string {
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(16);
  readSync(fd, buffer, 0, 16, 0);
  closeSync(fd);
  return buffer.toString("latin1");
}

function insertOwner(t: TestDatabase): void {
  t.db
    .insert(owner)
    .values({
      id: 1,
      passwordHash: "hash",
      totpSecretEnc: Buffer.from("s"),
      lastTotpStep: 0,
      createdAt: new Date(0),
    })
    .run();
}

describe("encrypted database (gate V1)", () => {
  let t: TestDatabase | undefined;
  afterEach(() => t?.dispose());

  it("writes a file that is not readable as plain SQLite", () => {
    t = createTestDatabase();
    insertOwner(t);
    t.close();
    expect(fileHeader(t.file)).not.toBe("SQLite format 3\u0000");
  });

  it("reopens with the right passphrase and refuses a wrong one", () => {
    t = createTestDatabase();
    insertOwner(t);
    t.close();
    expect(() => openDatabase(t?.file ?? "", "wrong-passphrase")).toThrow(
      /Cannot open encrypted database/,
    );
    const reopened = openDatabase(t.file, TEST_PASSPHRASE);
    const row = reopened.db.select().from(owner).where(eq(owner.id, 1)).get();
    expect(row?.passwordHash).toBe("hash");
    reopened.close();
  });

  it("rejects an empty or too short passphrase without creating a plaintext file", () => {
    t = createTestDatabase();
    const file = `${t.dir}/weak.db`;
    expect(() => openDatabase(file, "")).toThrow(/passphrase must be at least/);
    expect(() => openDatabase(file, "short")).toThrow(/passphrase must be at least/);
    expect(existsSync(file)).toBe(false);
  });

  it("supports FTS5 full-text search", () => {
    t = createTestDatabase();
    t.sqlite.exec("CREATE VIRTUAL TABLE notes_fts USING fts5(body)");
    t.sqlite
      .prepare("INSERT INTO notes_fts (body) VALUES (?), (?)")
      .run("mortgage amortisation schedule", "grocery receipt");
    const rows = t.sqlite
      .prepare("SELECT body FROM notes_fts WHERE notes_fts MATCH ?")
      .all("amortisation") as { body: string }[];
    expect(rows.map((row) => row.body)).toEqual(["mortgage amortisation schedule"]);
  });
});
