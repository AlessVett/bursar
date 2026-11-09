import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupCode } from "./setup-code";

describe("SetupCode", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-setup-"));
    file = path.join(dir, "setup-code");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the code to a private file and verifies it", () => {
    const setup = new SetupCode(file);
    setup.issue();
    const code = readFileSync(file, "utf8").trim();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(setup.verify(code)).toBe(true);
    expect(setup.verify(` ${code}\n`)).toBe(true);
    expect(setup.verify("wrong")).toBe(false);
  });

  it("forgets the code and removes the file when cleared", () => {
    const setup = new SetupCode(file);
    setup.issue();
    const code = readFileSync(file, "utf8").trim();
    setup.clear();
    expect(existsSync(file)).toBe(false);
    expect(setup.verify(code)).toBe(false);
  });
});
