import { generateKeyPairSync } from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Config } from "./config";
import { configSecrets, createLogger } from "./logger";

const NO_INTEGRATIONS = {
  claude: null,
  enableBanking: null,
  smtp: null,
  backup: { dir: "/data/backups", s3: null },
} satisfies Pick<Config, "claude" | "enableBanking" | "smtp" | "backup">;

function capture() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { sink, output: () => lines.join("") };
}

describe("createLogger", () => {
  it("redacts secrets at the top level and one level deep", () => {
    const { sink, output } = capture();
    const logger = createLogger("info", sink);
    logger.info(
      { password: "hunter2-secret", nested: { token: "tok-secret" }, keep: "visible" },
      "test",
    );
    expect(output()).not.toContain("hunter2-secret");
    expect(output()).not.toContain("tok-secret");
    expect(output()).toContain("visible");
    expect(output()).toContain("[redacted]");
  });

  it("redacts the secret names from the configuration", () => {
    const { sink, output } = capture();
    const logger = createLogger("info", sink);
    logger.info(
      {
        BURSAR_MASTER_KEY: "name-master-key",
        env: {
          ANTHROPIC_API_KEY: "name-api-key",
          CLAUDE_CODE_OAUTH_TOKEN: "name-oauth-token",
          EB_PRIVATE_KEY: "name-eb-key",
          SMTP_PASSWORD: "name-smtp",
          BACKUP_S3_SECRET_KEY: "name-s3",
          TUNNEL_TOKEN: "name-tunnel",
        },
        masterKey: Buffer.from("name-raw-master-key"),
        config: {
          masterKey: Buffer.from("name-nested-master-key"),
          claude: { envName: "CLAUDE_CODE_OAUTH_TOKEN", value: "name-claude-value" },
        },
        claude: { value: "name-top-claude-value" },
        res: { headers: { "set-cookie": "bursar_session=name-cookie" } },
        headers: { "set-cookie": "bursar_session=name-top-cookie" },
      },
      "config dump",
    );
    expect(output()).not.toMatch(/name-/);
    expect(output()).not.toContain(Buffer.from("name-raw-master-key").toString("base64"));
    expect(output()).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("scrubs loaded secret values wherever they appear", () => {
    const { sink, output } = capture();
    const secret = "loaded-secret-value-0123456789";
    const logger = createLogger("info", sink, [secret]);
    logger.info({ note: `prefix ${secret} suffix`, deep: { a: { b: [secret] } } }, `msg ${secret}`);
    logger.error({ err: new Error(`failed with ${secret}`) }, "boom");
    logger.child({ binding: secret }).warn("child");
    expect(output()).not.toContain(secret);
    expect(output()).toContain("prefix [redacted] suffix");
    expect(output().split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("scrubs a secret value in its JSON-escaped form", () => {
    const { sink, output } = capture();
    const secret = 'quote"and\\backslash-secret';
    createLogger("info", sink, [secret]).info({ value: secret }, "escaped");
    expect(output()).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(output()).toContain("[redacted]");
  });

  it("ignores values too short to scrub safely", () => {
    const { sink, output } = capture();
    createLogger("info", sink, ["", "tok"]).info({ word: "token tok" }, "short");
    expect(output()).toContain("token tok");
  });
});

describe("configSecrets", () => {
  it("lists the master key encodings and the Claude credential", () => {
    const masterKey = Buffer.alloc(32, 7);
    const secrets = configSecrets({
      masterKey,
      ...NO_INTEGRATIONS,
      claude: { envName: "CLAUDE_CODE_OAUTH_TOKEN", value: "oauth-credential-value" },
    });
    const { sink, output } = capture();
    const logger = createLogger("info", sink, secrets);
    const base64 = masterKey.toString("base64");
    logger.info(
      {
        padded: base64,
        unpadded: base64.replace(/=+$/, ""),
        url: masterKey.toString("base64url"),
        hex: masterKey.toString("hex"),
        credential: "oauth-credential-value",
      },
      "values",
    );
    expect(output()).not.toContain(base64.replace(/=+$/, ""));
    expect(output()).not.toContain(masterKey.toString("base64url"));
    expect(output()).not.toContain(masterKey.toString("hex"));
    expect(output()).not.toContain("oauth-credential-value");
  });

  it("works without a Claude credential", () => {
    expect(configSecrets({ masterKey: Buffer.alloc(32, 1), ...NO_INTEGRATIONS })).toHaveLength(3);
  });

  describe("integration secrets", () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString()
      .trim();
    const pemLines = pem.split("\n");
    const s3Secret = "s3-secret-value-0123456789";
    const smtpPassword = "smtp-password-value";
    const secrets = configSecrets({
      masterKey: Buffer.alloc(32, 7),
      claude: null,
      enableBanking: {
        applicationId: "8f1c2b7e-4d3a-4f6b-9a10-2c5d7e9b3a41",
        privateKeyPem: pem,
        apiBaseUrl: "https://api.enablebanking.com",
      },
      smtp: {
        host: "smtp.example.test",
        port: 587,
        security: "starttls",
        user: "mailer",
        password: smtpPassword,
        from: "bursar@example.test",
      },
      backup: {
        dir: "/data/backups",
        s3: {
          endpoint: new URL("https://s3.example.test"),
          region: "auto",
          bucket: "bursar-backups",
          prefix: "bursar",
          accessKeyId: "access-key-id-value",
          secretAccessKey: s3Secret,
        },
      },
    });

    it("adds the PEM, each of its body lines, the SMTP password and the S3 secret", () => {
      expect(secrets).toContain(pem);
      expect(secrets).toContain(pemLines[1]);
      expect(secrets).not.toContain(pemLines[0]);
      expect(secrets).not.toContain(pemLines.at(-1));
      expect(secrets).toContain(smtpPassword);
      expect(secrets).toContain(s3Secret);
    });

    it("scrubs the whole PEM, a single PEM line and a re-wrapped PEM from a log line", () => {
      const { sink, output } = capture();
      const logger = createLogger("info", sink, secrets);
      logger.info({ dump: pem, oneLine: pem.replaceAll("\n", " "), line: pemLines[2] }, "key");
      logger.warn(`failed with ${pemLines[3]} in the middle`);
      for (const line of pemLines.slice(1, -1)) expect(output()).not.toContain(line);
      expect(output()).toContain("[redacted]");
    });

    it("scrubs the SMTP password and the S3 secret wherever they appear", () => {
      const { sink, output } = capture();
      const logger = createLogger("info", sink, secrets);
      logger.error({ err: new Error(`AUTH failed for ${smtpPassword}`) }, `s3 said ${s3Secret}`);
      expect(output()).not.toContain(smtpPassword);
      expect(output()).not.toContain(s3Secret);
    });

    it("skips an unset SMTP password", () => {
      const withoutPassword = configSecrets({
        masterKey: Buffer.alloc(32, 7),
        ...NO_INTEGRATIONS,
        smtp: {
          host: "localhost",
          port: 1025,
          security: "none",
          user: null,
          password: null,
          from: "bursar@example.test",
        },
      });
      expect(withoutPassword).toHaveLength(3);
    });
  });
});

describe("redaction of banking identifiers", () => {
  it("redacts provider session ids, authorisation codes, state tokens and IBANs by field name", () => {
    const { sink, output } = capture();
    createLogger("info", sink).info(
      {
        providerSessionId: "field-session-1",
        provider_session_id: "field-session-2",
        session_id: "field-session-3",
        authorizationCode: "field-auth-code",
        stateToken: "field-state-token",
        iban: "FIELDIBAN0000000000",
        privateKeyPem: "field-private-key",
        secretAccessKey: "field-s3-secret",
        nested: {
          providerSessionId: "nested-session-1",
          iban: "NESTEDIBAN000000000",
          authorizationCode: "nested-auth-code",
          stateToken: "nested-state-token",
        },
        request: { headers: { "psu-ip-address": "203.0.113.9", accept: "application/json" } },
        headers: { "psu-ip-address": "203.0.113.10" },
        keep: "visible",
      },
      "banking",
    );
    expect(output()).not.toMatch(/field-|nested-|FIELDIBAN|NESTEDIBAN|203\.0\.113/);
    expect(output()).toContain("visible");
    expect(output()).toContain("application/json");
  });

  it("keeps provider error codes: the generic code key is not redacted", () => {
    const { sink, output } = capture();
    createLogger("info", sink).warn(
      { errorCode: "ASPSP_RATE_LIMIT_EXCEEDED", code: "WRONG_ASPSP_PROVIDED", status: 429 },
      "provider error",
    );
    expect(output()).toContain("ASPSP_RATE_LIMIT_EXCEEDED");
    expect(output()).toContain("WRONG_ASPSP_PROVIDED");
  });
});
