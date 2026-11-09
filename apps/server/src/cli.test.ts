import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand } from "./cli";

describe("bursar init", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a 32-byte base64 key to a private file without printing it", () => {
    const file = path.join(dir, "master_key");
    const printed: string[] = [];
    expect(initCommand(["--out", file], (line) => printed.push(line))).toBe(0);
    const key = readFileSync(file, "utf8").trim();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(printed.join("\n")).not.toContain(key);
  });

  it("refuses to overwrite an existing key", () => {
    const file = path.join(dir, "master_key");
    initCommand(["--out", file], () => {});
    expect(initCommand(["--out", file], () => {})).toBe(1);
  });

  it("requires --out", () => {
    expect(initCommand([], () => {})).toBe(2);
  });
});
