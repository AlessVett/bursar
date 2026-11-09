import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { configSecrets, createLogger } from "./logger";

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
    expect(configSecrets({ masterKey: Buffer.alloc(32, 1), claude: null })).toHaveLength(3);
  });
});
