import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { generateMasterKey } from "./crypto";

const USAGE = "Usage: bursar init --out <path>";

export function initCommand(args: string[], log: (line: string) => void = console.log): number {
  const index = args.indexOf("--out");
  const target = index >= 0 ? args[index + 1] : undefined;
  if (!target) {
    log(USAGE);
    return 2;
  }
  try {
    writeFileSync(target, `${generateMasterKey()}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      log(`Refusing to overwrite an existing file: ${target}`);
      return 1;
    }
    throw error;
  }
  log(`Master key written to ${target} (mode 600).`);
  log("Keep an offline copy of this file: without it the data cannot be decrypted.");
  return 0;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "init") return initCommand(rest);
  console.error(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
