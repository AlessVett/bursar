import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

/** Non-secret values that compose.yaml passes to the app with an empty default (Task 8 names). */
const NON_SECRET_VARIABLES = [
  "EB_APPLICATION_ID",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURITY",
  "SMTP_USER",
  "SMTP_FROM",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_REGION",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_PREFIX",
  "BACKUP_S3_ACCESS_KEY_ID",
] as const;

/** One optional integration per overlay: its secret file and the `_FILE` variable it fills. */
const OVERLAYS = [
  { file: "compose.banking.yaml", secret: "eb_private_key", variable: "EB_PRIVATE_KEY_FILE" },
  { file: "compose.smtp.yaml", secret: "smtp_password", variable: "SMTP_PASSWORD_FILE" },
  {
    file: "compose.backup.yaml",
    secret: "backup_s3_secret_key",
    variable: "BACKUP_S3_SECRET_KEY_FILE",
  },
] as const;

const LOGGING = ["driver: json-file", 'max-size: "10m"', 'max-file: "3"'];

const emptyDefault = (name: string): string => `${name}: \${${name}:-}`;

const noFiles = (file: string): string => {
  throw new Error(`unexpected read of ${file}`);
};

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

describe("compose.yaml", () => {
  const compose = read("deploy/compose.yaml");
  const appBlock = compose.slice(compose.indexOf("\n  app:"), compose.indexOf("\n  cloudflared:"));
  const cloudflaredBlock = compose.slice(
    compose.indexOf("\n  cloudflared:"),
    compose.indexOf("\nsecrets:"),
  );

  it.each(NON_SECRET_VARIABLES)("passes %s to the app with an empty default", (name) => {
    expect(appBlock).toContain(emptyDefault(name));
  });

  it("rotates the container logs of app and cloudflared", () => {
    for (const block of [appBlock, cloudflaredBlock]) {
      expect(block).toContain("logging:");
      for (const line of LOGGING) expect(block).toContain(line);
    }
  });

  it("leaves every optional secret to its overlay", () => {
    for (const { secret } of OVERLAYS) expect(compose).not.toContain(secret);
    expect(compose).not.toContain("claude_credential");
  });

  it("loads with every empty default and reports no optional integration", () => {
    const empties = [...compose.matchAll(/^\s+([A-Z0-9_]+): \$\{\1:-\}$/gm)].map((m) => m[1] ?? "");
    for (const name of NON_SECRET_VARIABLES) expect(empties).toContain(name);
    const env = {
      BURSAR_PUBLIC_URL: "https://bursar.example.com",
      TZ: "Europe/Rome",
      BURSAR_MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
      ...Object.fromEntries(empties.map((name) => [name, ""])),
    };
    const config = loadConfig(env, noFiles);
    expect(config.enableBanking).toBeNull();
    expect(config.smtp).toBeNull();
    expect(config.backup.s3).toBeNull();
  });
});

describe("compose overlays", () => {
  it.each(OVERLAYS)("$file adds the $secret secret and $variable", ({ file, secret, variable }) => {
    const overlay = read(`deploy/${file}`);
    expect(overlay).toContain(`- ${variable}=/run/secrets/${secret}`);
    expect(overlay).toContain(`      - ${secret}\n`);
    expect(overlay).toContain(
      `  ${secret}:\n    file: \${BURSAR_SECRETS_DIR:-./secrets}/${secret}`,
    );
    expect(overlay.match(/^\s+[a-z0-9_]+:\n\s+file:/gm)).toHaveLength(1);
  });

  const dockerAvailable =
    spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!dockerAvailable)("merges with the base file into a valid compose model", () => {
    const secrets = scratchDir("bursar-compose-secrets-");
    for (const name of ["master_key", "claude_credential", ...OVERLAYS.map((o) => o.secret)]) {
      writeFileSync(path.join(secrets, name), "");
    }
    const files = ["compose.yaml", "compose.claude.yaml", ...OVERLAYS.map((o) => o.file)].flatMap(
      (file) => ["-f", path.join(repoRoot, "deploy", file)],
    );
    const model = execFileSync("docker", ["compose", ...files, "--profile", "tunnel", "config"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BURSAR_PUBLIC_URL: "https://bursar.example.com",
        TZ: "Europe/Rome",
        BURSAR_SECRETS_DIR: secrets,
      },
    });
    for (const { secret, variable } of OVERLAYS) {
      expect(model).toContain(`${variable}: /run/secrets/${secret}`);
    }
    expect(model.match(/max-size: 10m/g)).toHaveLength(2);
  });
});

describe("env.example", () => {
  const example = read("deploy/env.example");

  it.each(NON_SECRET_VARIABLES)("documents %s as a commented entry", (name) => {
    expect(example).toMatch(new RegExp(`^# ${name}=`, "m"));
  });

  it("never holds a secret value, only the names of the secret files", () => {
    expect(example).not.toMatch(
      /^#?\s*(EB_PRIVATE_KEY|SMTP_PASSWORD|BACKUP_S3_SECRET_KEY)(_FILE)?=/m,
    );
    for (const { secret } of OVERLAYS) expect(example).toContain(secret);
  });

  it("reminds operators to trust CF-Connecting-IP behind a tunnel", () => {
    expect(example).toMatch(/^#.*BURSAR_TRUST_CF_CONNECTING_IP=true/m);
    expect(example).toMatch(/^BURSAR_TRUST_CF_CONNECTING_IP=false$/m);
  });
});

describe("remote-update.sh", () => {
  const script = path.join(repoRoot, "deploy", "remote-update.sh");

  /** Runs the script against a stub `docker` and returns the compose files of the `up` call. */
  function composeFilesFor(options: { secrets: readonly string[]; relative?: boolean }): string[] {
    const base = scratchDir("bursar-remote-update-");
    const dir = path.join(base, "deploy-dir");
    const releaseDeploy = path.join(dir, "releases", "r1", "deploy");
    const secretsDir = options.relative
      ? path.join(releaseDeploy, "secrets")
      : path.join(base, "secrets");
    mkdirSync(releaseDeploy, { recursive: true });
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(
      path.join(dir, ".env"),
      options.relative ? "TZ=UTC\n" : `BURSAR_SECRETS_DIR=${secretsDir}\n`,
    );
    for (const name of ["master_key", ...options.secrets]) {
      writeFileSync(path.join(secretsDir, name), "secret-stub");
    }
    const bin = path.join(base, "bin");
    mkdirSync(bin);
    const log = path.join(base, "docker.log");
    writeFileSync(path.join(bin, "docker"), '#!/bin/sh\necho "$*" >> "$DOCKER_LOG"\n');
    chmodSync(path.join(bin, "docker"), 0o755);
    execFileSync("bash", [script, dir, "r1"], {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        DOCKER_LOG: log,
      },
      stdio: "pipe",
    });
    const upCall = readFileSync(log, "utf8")
      .split("\n")
      .find((line) => line.includes(" up "));
    expect(upCall).toBeDefined();
    return [...(upCall ?? "").matchAll(/-f (\S+)/g)].map((m) => path.basename(m[1] ?? ""));
  }

  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
  });

  it("uses only the base file when no optional secret exists", () => {
    expect(composeFilesFor({ secrets: [] })).toEqual(["compose.yaml"]);
  });

  it("adds every overlay whose secret file exists, in a fixed order", () => {
    expect(
      composeFilesFor({
        secrets: ["backup_s3_secret_key", "smtp_password", "eb_private_key", "claude_credential"],
      }),
    ).toEqual([
      "compose.yaml",
      "compose.claude.yaml",
      "compose.banking.yaml",
      "compose.smtp.yaml",
      "compose.backup.yaml",
    ]);
  });

  it("skips the overlays whose secret file is missing", () => {
    expect(composeFilesFor({ secrets: ["smtp_password", "backup_s3_secret_key"] })).toEqual([
      "compose.yaml",
      "compose.smtp.yaml",
      "compose.backup.yaml",
    ]);
  });

  it("resolves a relative secrets directory against the release's deploy directory", () => {
    expect(composeFilesFor({ secrets: ["eb_private_key"], relative: true })).toEqual([
      "compose.yaml",
      "compose.banking.yaml",
    ]);
  });
});

describe("documentation", () => {
  // Read inside each test: a missing document fails that test, not the whole file.
  it.each([
    "REDIRECT_URI_NOT_ALLOWED",
    "EXPIRED_SESSION",
    "ASPSP_RATE_LIMIT_EXCEEDED",
    "PSU_HEADER_NOT_PROVIDED",
  ])("enable-banking.md explains %s", (code) => {
    expect(read("docs/enable-banking.md")).toContain(`### \`${code}\``);
  });

  it("enable-banking.md covers setup, restricted mode and the Terms gate", () => {
    const enableBanking = read("docs/enable-banking.md");
    for (const text of [
      "openssl req -x509",
      "chmod 600",
      "https://<hostname>/api/banks/callback",
      "http://localhost:5173/api/banks/callback",
      "restricted mode",
      "Link every account",
      "gate V5",
      "BURSAR_TRUST_CF_CONNECTING_IP=true",
    ]) {
      expect(enableBanking).toContain(text);
    }
  });

  it("backup-restore.md covers the set, retention, R2, the CLI and the restore test", () => {
    const backupRestore = read("docs/backup-restore.md");
    for (const text of [
      "manifest.json",
      "7 daily, 4 weekly and 6 monthly",
      "/data/backups",
      "never stored in a backup",
      "backup_s3_secret_key",
      "https://<account-id>.r2.cloudflarestorage.com",
      "backup run",
      "backup list --remote",
      "restore --set <setId> --from s3 --to /tmp/restore-test",
      "banking status --data-dir /tmp/restore-test",
      "bursar.db-wal",
      "checksum_mismatch",
      "Interrupted by a restart",
    ]) {
      expect(backupRestore).toContain(text);
    }
  });

  it("deployment.md documents every overlay and secret file", () => {
    const deployment = read("docs/deployment.md");
    for (const { file, secret } of OVERLAYS) {
      expect(deployment).toContain(file);
      expect(deployment).toContain(secret);
    }
    expect(deployment).toContain("banking status");
    expect(deployment).toContain("backup run");
    expect(deployment).toContain("docs/enable-banking.md");
    expect(deployment).toContain("docs/backup-restore.md");
  });

  it("README.md has the bank accounts and backups sections and the QA command", () => {
    const readme = read("README.md");
    expect(readme).toContain("## Bank accounts");
    expect(readme).toContain("## Backups");
    expect(readme).toContain("docs/enable-banking.md");
    expect(readme).toContain("docs/backup-restore.md");
    expect(readme).toContain("pnpm --filter @bursar/web qa");
  });

  it("uses placeholders only: no personal hosts, addresses or emails", () => {
    const files = [
      "README.md",
      "docs/deployment.md",
      "docs/enable-banking.md",
      "docs/backup-restore.md",
      "deploy/env.example",
      "deploy/compose.yaml",
      "deploy/compose.banking.yaml",
      "deploy/compose.smtp.yaml",
      "deploy/compose.backup.yaml",
      "deploy/remote-update.sh",
    ];
    const allowedHost =
      /^(app|localhost|127\.0\.0\.1|(.*\.)?(example\.com|enablebanking\.com|cloudflare\.com|cloudflarestorage\.com|cloudflareaccess\.com|github\.com|openssl\.org))$/;
    for (const file of files) {
      const text = read(file).replace(/<[^>\n]*>/g, "");
      for (const match of text.matchAll(/https?:\/\/([^\s/)`'"<>:]*)/g)) {
        const host = (match[1] ?? "").replace(/^\./, "");
        expect({ file, host, ok: host === "" || allowedHost.test(host) }).toEqual({
          file,
          host,
          ok: true,
        });
      }
      for (const match of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
        expect({ file, address: match[0] }).toEqual({ file, address: "127.0.0.1" });
      }
      for (const match of text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) {
        expect({ file, emailDomain: match[1] }).toEqual({ file, emailDomain: "example.com" });
      }
    }
  });
});
