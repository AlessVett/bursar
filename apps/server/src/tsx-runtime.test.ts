import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const serverRoot = path.resolve(import.meta.dirname, "..");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

/** Runs a source entrypoint through tsx the way the package scripts do, with an empty environment. */
function runWithTsx(entry: string) {
  return spawnSync(process.execPath, [tsxCli, "--tsconfig", "tsconfig.runtime.json", entry], {
    cwd: serverRoot,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("tsx runtime configuration", () => {
  // tsx applies tsconfig "paths" at runtime. The type-only mapping in tsconfig.json would make it
  // load the SQLCipher driver's index.d.ts instead of its JavaScript.
  it("loads the entrypoint and the database driver", () => {
    const result = runWithTsx("src/index.ts");
    // Exit code 78 means every module loaded and startup stopped at configuration validation.
    expect(result.stderr).toContain("Invalid configuration");
    expect(result.stderr).not.toContain("ReferenceError");
    expect(result.status).toBe(78);
  });

  it("runs the CLI", () => {
    const result = runWithTsx("src/cli.ts");
    expect(result.stderr).toContain("bursar init --out <path>");
    expect(result.status).toBe(2);
  });

  it("uses the runtime tsconfig in every tsx script", () => {
    const { scripts } = JSON.parse(readFileSync(path.join(serverRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const tsxScripts = Object.values(scripts).filter((script) => /^tsx\b/.test(script));
    expect(tsxScripts.length).toBeGreaterThanOrEqual(2);
    for (const script of tsxScripts) expect(script).toContain("--tsconfig tsconfig.runtime.json");
  });
});
