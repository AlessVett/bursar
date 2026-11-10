import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadBackup,
  loadConfig,
  loadEnableBanking,
  loadSmtp,
  readSecret,
} from "./config";

const KEY = Buffer.alloc(32, 7).toString("base64");
const baseEnv = {
  BURSAR_PUBLIC_URL: "https://bursar.example.test",
  TZ: "Europe/Rome",
  BURSAR_MASTER_KEY: KEY,
  CF_ACCESS_TEAM_DOMAIN: "team.example.test",
  CF_ACCESS_AUD: "aud",
};
const noFiles = (path: string): string => {
  throw new Error(`unexpected read of ${path}`);
};

describe("loadConfig", () => {
  it("builds a config with defaults from the minimal environment", () => {
    const config = loadConfig(baseEnv, noFiles);
    expect(config.port).toBe(8080);
    expect(config.host).toBe("127.0.0.1");
    expect(config.publicUrl.origin).toBe("https://bursar.example.test");
    expect(config.timezone).toBe("Europe/Rome");
    expect(config.masterKey).toEqual(Buffer.alloc(32, 7));
    expect(config.cfAccess).toEqual({ teamDomain: "team.example.test", audience: "aud" });
    expect(config.claude).toBeNull();
    expect(config.webDistDir).toBeNull();
    expect(config.enableBanking).toBeNull();
    expect(config.smtp).toBeNull();
    expect(config.backup).toEqual({ dir: path.join(config.dataDir, "backups"), s3: null });
  });

  it.each([
    "bursar.example.test:8080",
    "http://bursar.example.test",
    "ftp://bursar.example.test",
    "https://user:pw@bursar.example.test",
    "https://bursar.example.test/app",
    "https://bursar.example.test/?x=1",
    "not a url",
  ])("rejects the public URL %s", (url) => {
    expect(() => loadConfig({ ...baseEnv, BURSAR_PUBLIC_URL: url }, noFiles)).toThrow(
      /BURSAR_PUBLIC_URL/,
    );
  });

  it("accepts http on a loopback public URL and a trailing slash", () => {
    expect(
      loadConfig({ ...baseEnv, BURSAR_PUBLIC_URL: "http://127.0.0.1:8080" }, noFiles).publicUrl
        .origin,
    ).toBe("http://127.0.0.1:8080");
    expect(
      loadConfig({ ...baseEnv, BURSAR_PUBLIC_URL: "https://bursar.example.test/" }, noFiles)
        .publicUrl.origin,
    ).toBe("https://bursar.example.test");
  });

  it("treats empty or blank host and directories as unset", () => {
    const config = loadConfig(
      {
        ...baseEnv,
        BURSAR_HOST: "",
        BURSAR_DATA_DIR: "  ",
        BURSAR_MIGRATIONS_DIR: "",
        BURSAR_WEB_DIST: "",
      },
      noFiles,
    );
    expect(config.host).toBe("127.0.0.1");
    expect(config.dataDir).toBe(path.resolve("./data"));
    expect(config.migrationsDir).toBe(path.resolve("./drizzle"));
    expect(config.webDistDir).toBeNull();
  });

  it("rejects a malformed host and accepts an explicit one", () => {
    expect(() => loadConfig({ ...baseEnv, BURSAR_HOST: "bad host!" }, noFiles)).toThrow(
      /BURSAR_HOST/,
    );
    expect(loadConfig({ ...baseEnv, BURSAR_HOST: "0.0.0.0" }, noFiles).host).toBe("0.0.0.0");
  });

  it("stores an IPv6 host without brackets so it can be bound", () => {
    expect(loadConfig({ ...baseEnv, BURSAR_HOST: "[::1]" }, noFiles).host).toBe("::1");
    expect(loadConfig({ ...baseEnv, BURSAR_HOST: "::" }, noFiles).host).toBe("::");
    expect(() => loadConfig({ ...baseEnv, BURSAR_HOST: "[localhost]" }, noFiles)).toThrow(
      /BURSAR_HOST/,
    );
    expect(() => loadConfig({ ...baseEnv, BURSAR_HOST: "[127.0.0.1]" }, noFiles)).toThrow(
      /BURSAR_HOST/,
    );
  });

  it("treats empty port and log level as unset", () => {
    const config = loadConfig({ ...baseEnv, BURSAR_PORT: "", BURSAR_LOG_LEVEL: " " }, noFiles);
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("info");
  });

  it("reads an explicit port and log level", () => {
    const config = loadConfig(
      { ...baseEnv, BURSAR_PORT: " 9090 ", BURSAR_LOG_LEVEL: "debug" },
      noFiles,
    );
    expect(config.port).toBe(9090);
    expect(config.logLevel).toBe("debug");
  });

  it.each(["0", "65536", "80.5", "8080abc", "0x1F90", "-1"])("rejects the port %s", (port) => {
    expect(() => loadConfig({ ...baseEnv, BURSAR_PORT: port }, noFiles)).toThrow(/BURSAR_PORT/);
  });

  it("rejects an unknown log level", () => {
    expect(() => loadConfig({ ...baseEnv, BURSAR_LOG_LEVEL: "verbose" }, noFiles)).toThrow(
      /BURSAR_LOG_LEVEL/,
    );
  });

  it("stores the canonical timezone name", () => {
    expect(loadConfig({ ...baseEnv, TZ: "europe/rome" }, noFiles).timezone).toBe("Europe/Rome");
    expect(loadConfig({ ...baseEnv, TZ: " Europe/Rome " }, noFiles).timezone).toBe("Europe/Rome");
    expect(loadConfig({ ...baseEnv, TZ: "utc" }, noFiles).timezone).toBe("UTC");
  });

  it.each(["+01:00", "-05:00", "+0100"])("rejects the offset-only timezone %s", (tz) => {
    expect(() => loadConfig({ ...baseEnv, TZ: tz }, noFiles)).toThrow(/TZ/);
  });

  it("treats an empty timezone as missing", () => {
    expect(() => loadConfig({ ...baseEnv, TZ: " " }, noFiles)).toThrow(/TZ is required/);
  });

  it("reports every problem at once", () => {
    let error: unknown;
    try {
      loadConfig({}, noFiles);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems.join("\n");
    expect(problems).toContain("BURSAR_PUBLIC_URL");
    expect(problems).toContain("TZ");
    expect(problems).toContain("BURSAR_MASTER_KEY");
  });

  it("reads the master key from a *_FILE path", () => {
    const env = { ...baseEnv, BURSAR_MASTER_KEY: undefined, BURSAR_MASTER_KEY_FILE: "/run/key" };
    const config = loadConfig(env, (path) => {
      expect(path).toBe("/run/key");
      return `${KEY}\n`;
    });
    expect(config.masterKey).toEqual(Buffer.alloc(32, 7));
  });

  it("rejects a master key that is not 32 bytes", () => {
    const env = { ...baseEnv, BURSAR_MASTER_KEY: Buffer.alloc(16).toString("base64") };
    expect(() => loadConfig(env, noFiles)).toThrow(/32 bytes/);
  });

  it("rejects an unknown timezone", () => {
    expect(() => loadConfig({ ...baseEnv, TZ: "Mars/Olympus" }, noFiles)).toThrow(
      /not a valid IANA timezone/,
    );
  });

  it("requires both Cloudflare Access settings together", () => {
    expect(() => loadConfig({ ...baseEnv, CF_ACCESS_TEAM_DOMAIN: "" }, noFiles)).toThrow(
      /must be set together/,
    );
  });

  it("treats Cloudflare Access as optional for an HTTPS public URL", () => {
    const { CF_ACCESS_TEAM_DOMAIN: _t, CF_ACCESS_AUD: _a, ...noAccess } = baseEnv;
    const config = loadConfig(noAccess, noFiles);
    expect(config.publicUrl.origin).toBe("https://bursar.example.test");
    expect(config.cfAccess).toBeNull();
  });

  it("treats empty Cloudflare Access values as unset", () => {
    const config = loadConfig(
      { ...baseEnv, CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: " " },
      noFiles,
    );
    expect(config.cfAccess).toBeNull();
  });

  it("allows a loopback public URL without Cloudflare Access", () => {
    const { CF_ACCESS_TEAM_DOMAIN: _t, CF_ACCESS_AUD: _a, ...noAccess } = baseEnv;
    const config = loadConfig({ ...noAccess, BURSAR_PUBLIC_URL: "http://localhost:5173" }, noFiles);
    expect(config.cfAccess).toBeNull();
  });

  it.each([
    "https://team.example.test",
    "team.example.test/",
    "team.example.test/cdn-cgi",
    "team example.test",
    "localhost",
  ])("rejects the Cloudflare Access team domain %s", (teamDomain) => {
    expect(() => loadConfig({ ...baseEnv, CF_ACCESS_TEAM_DOMAIN: teamDomain }, noFiles)).toThrow(
      /CF_ACCESS_TEAM_DOMAIN must be a bare hostname/,
    );
  });

  it.each([
    "http://localhost.attacker.example",
    "http://localhostx",
    "http://127.0.0.1.nip.io",
    "http://127.0.0.1.attacker.example",
    "http://128.0.0.1",
    "http://[::2]",
  ])("rejects http on the look-alike loopback URL %s", (url) => {
    expect(() => loadConfig({ ...baseEnv, BURSAR_PUBLIC_URL: url }, noFiles)).toThrow(
      /only on a loopback host/,
    );
  });

  it.each([
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://127.1.2.3:8080", "http://127.1.2.3:8080"],
    ["http://[::1]:8080", "http://[::1]:8080"],
  ])("accepts http on the loopback URL %s", (url, origin) => {
    expect(loadConfig({ ...baseEnv, BURSAR_PUBLIC_URL: url }, noFiles).publicUrl.origin).toBe(
      origin,
    );
  });

  it("does not trust CF-Connecting-IP unless it is enabled explicitly", () => {
    expect(loadConfig(baseEnv, noFiles).trustCfConnectingIp).toBe(false);
    expect(
      loadConfig({ ...baseEnv, BURSAR_TRUST_CF_CONNECTING_IP: "" }, noFiles).trustCfConnectingIp,
    ).toBe(false);
    expect(
      loadConfig({ ...baseEnv, BURSAR_TRUST_CF_CONNECTING_IP: "false" }, noFiles)
        .trustCfConnectingIp,
    ).toBe(false);
    expect(
      loadConfig({ ...baseEnv, BURSAR_TRUST_CF_CONNECTING_IP: "true" }, noFiles)
        .trustCfConnectingIp,
    ).toBe(true);
    expect(
      loadConfig({ ...baseEnv, BURSAR_TRUST_CF_CONNECTING_IP: " TRUE " }, noFiles)
        .trustCfConnectingIp,
    ).toBe(true);
  });

  it("rejects a malformed CF-Connecting-IP trust setting", () => {
    expect(() => loadConfig({ ...baseEnv, BURSAR_TRUST_CF_CONNECTING_IP: "yes" }, noFiles)).toThrow(
      /BURSAR_TRUST_CF_CONNECTING_IP must be true or false/,
    );
  });

  it("enables Cloudflare Access when both settings are present", () => {
    const config = loadConfig(
      { ...baseEnv, CF_ACCESS_TEAM_DOMAIN: "team.example.test", CF_ACCESS_AUD: "aud" },
      noFiles,
    );
    expect(config.cfAccess).toEqual({ teamDomain: "team.example.test", audience: "aud" });
  });

  it("rejects two Claude credentials at once", () => {
    const env = { ...baseEnv, ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "b" };
    expect(() => loadConfig(env, noFiles)).toThrow(/not both/);
  });

  it("loads an OAuth token credential", () => {
    const config = loadConfig({ ...baseEnv, CLAUDE_CODE_OAUTH_TOKEN: "tok" }, noFiles);
    expect(config.claude).toEqual({ envName: "CLAUDE_CODE_OAUTH_TOKEN", value: "tok" });
  });
});

describe("readSecret", () => {
  it("refuses a variable and its _FILE variant together", () => {
    expect(() => readSecret({ A: "x", A_FILE: "/f" }, "A", noFiles)).toThrow(ConfigError);
  });

  it("rejects an empty secret file", () => {
    expect(() => readSecret({ A_FILE: "/f" }, "A", () => "  \n")).toThrow(/empty/);
  });

  it("names the variable when the secret file is not readable", () => {
    const denied = () => {
      throw Object.assign(new Error("EACCES: permission denied, open '/run/secrets/a'"), {
        code: "EACCES",
      });
    };
    expect(() => readSecret({ A_FILE: "/run/secrets/a" }, "A", denied)).toThrow(ConfigError);
    expect(() => readSecret({ A_FILE: "/run/secrets/a" }, "A", denied)).toThrow(
      /A_FILE points to \/run\/secrets\/a, which cannot be read \(EACCES\).*uid 1000/,
    );
  });

  it("names the variable when the secret file is missing, using the real file system", () => {
    const missing = path.join(tmpdir(), `bursar-missing-${process.pid}`, "master_key");
    expect(() => readSecret({ A_FILE: missing }, "A")).toThrow(
      /A_FILE .*cannot be read \(ENOENT\)/,
    );
  });

  it("reports an unreadable master key file with the other configuration problems", () => {
    const env = { BURSAR_MASTER_KEY_FILE: "/run/secrets/master_key" };
    let error: unknown;
    try {
      loadConfig(env, () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems.join("\n");
    expect(problems).toContain("BURSAR_MASTER_KEY_FILE points to /run/secrets/master_key");
    expect(problems).toContain("BURSAR_PUBLIC_URL");
  });

  it("rethrows errors that are not file system errors", () => {
    const boom = () => {
      throw new TypeError("boom");
    };
    expect(() => readSecret({ A_FILE: "/f" }, "A", boom)).toThrow(TypeError);
  });
});

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_PKCS8 = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const RSA_PKCS1 = rsa.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const RSA_ENCRYPTED = rsa.privateKey
  .export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "test-passphrase" })
  .toString();
const EC_PKCS8 = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const APP_ID = "8f1c2b7e-4d3a-4f6b-9a10-2c5d7e9b3a41";

/** A `readFile` stub serving the given files and failing on anything else. */
const filesOf =
  (files: Record<string, string>) =>
  (file: string): string => {
    const content = files[file];
    if (content === undefined) throw new Error(`unexpected read of ${file}`);
    return content;
  };

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error("expected a ConfigError");
}

describe("Enable Banking configuration", () => {
  const eb = { EB_APPLICATION_ID: APP_ID, EB_PRIVATE_KEY: RSA_PKCS8 };

  it("is null when nothing is set, also through loadConfig", () => {
    expect(loadEnableBanking({}, noFiles)).toBeNull();
    expect(loadEnableBanking({ EB_APPLICATION_ID: " ", EB_PRIVATE_KEY: "" }, noFiles)).toBeNull();
    expect(loadConfig(baseEnv, noFiles).enableBanking).toBeNull();
  });

  it("parses a complete configuration with the default API address", () => {
    expect(loadEnableBanking(eb, noFiles)).toEqual({
      applicationId: APP_ID,
      privateKeyPem: RSA_PKCS8.trim(),
      apiBaseUrl: "https://api.enablebanking.com",
    });
    expect(loadConfig({ ...baseEnv, ...eb }, noFiles).enableBanking?.applicationId).toBe(APP_ID);
  });

  it("accepts a PKCS#1 RSA key", () => {
    expect(loadEnableBanking({ ...eb, EB_PRIVATE_KEY: RSA_PKCS1 }, noFiles)?.privateKeyPem).toBe(
      RSA_PKCS1.trim(),
    );
  });

  it("accepts a key with CRLF line endings", () => {
    const crlf = RSA_PKCS8.trim().replaceAll("\n", "\r\n");
    expect(loadEnableBanking({ ...eb, EB_PRIVATE_KEY: crlf }, noFiles)?.applicationId).toBe(APP_ID);
  });

  it("rejects a passphrase-protected key, which Bursar cannot unlock", () => {
    expect(
      problemsOf(() => loadEnableBanking({ ...eb, EB_PRIVATE_KEY: RSA_ENCRYPTED }, noFiles)),
    ).toEqual(["EB_PRIVATE_KEY is not a valid unencrypted PEM private key (PKCS#1 or PKCS#8)"]);
  });

  it("restores the line breaks of a key given on one line with literal \\n", () => {
    const oneLine = RSA_PKCS8.trim().replaceAll("\n", "\\n");
    expect(loadEnableBanking({ ...eb, EB_PRIVATE_KEY: oneLine }, noFiles)?.privateKeyPem).toBe(
      RSA_PKCS8.trim(),
    );
  });

  it("reads the key from a *_FILE path", () => {
    const env = { EB_APPLICATION_ID: APP_ID, EB_PRIVATE_KEY_FILE: "/run/secrets/eb_key" };
    const config = loadEnableBanking(env, filesOf({ "/run/secrets/eb_key": `${RSA_PKCS8}\n` }));
    expect(config?.privateKeyPem).toBe(RSA_PKCS8.trim());
  });

  it("accepts an https API base URL and stores its origin", () => {
    expect(
      loadEnableBanking({ ...eb, EB_API_BASE_URL: "https://eb.example.test/" }, noFiles)
        ?.apiBaseUrl,
    ).toBe("https://eb.example.test");
    expect(
      loadEnableBanking({ ...eb, EB_API_BASE_URL: "https://eb.example.test:8443" }, noFiles)
        ?.apiBaseUrl,
    ).toBe("https://eb.example.test:8443");
  });

  it.each([
    ["http://eb.example.test", /EB_API_BASE_URL must use https/],
    ["https://eb.example.test/v1", /EB_API_BASE_URL must not contain a path/],
    ["https://eb.example.test/?x=1", /EB_API_BASE_URL must not contain a path/],
    ["https://user:pw@eb.example.test", /EB_API_BASE_URL must not contain credentials/],
    ["eb.example.test", /EB_API_BASE_URL must be an absolute https URL/],
  ])("rejects the API base URL %s", (url, message) => {
    expect(problemsOf(() => loadEnableBanking({ ...eb, EB_API_BASE_URL: url }, noFiles))).toEqual([
      expect.stringMatching(message),
    ]);
  });

  it("rejects a bad API base URL even when the integration is otherwise unset", () => {
    expect(() => loadEnableBanking({ EB_API_BASE_URL: "http://eb.example.test" }, noFiles)).toThrow(
      /EB_API_BASE_URL/,
    );
  });

  it("requires the application id and the key together", () => {
    expect(problemsOf(() => loadEnableBanking({ EB_APPLICATION_ID: APP_ID }, noFiles))).toEqual([
      "EB_PRIVATE_KEY (or EB_PRIVATE_KEY_FILE) is required when EB_APPLICATION_ID is set",
    ]);
    expect(problemsOf(() => loadEnableBanking({ EB_PRIVATE_KEY: RSA_PKCS8 }, noFiles))).toEqual([
      "EB_APPLICATION_ID is required when EB_PRIVATE_KEY (or EB_PRIVATE_KEY_FILE) is set",
    ]);
  });

  it.each(["not-a-uuid", "8f1c2b7e4d3a4f6b9a102c5d7e9b3a41", `${APP_ID}0`, `x${APP_ID.slice(1)}`])(
    "rejects the application id %s",
    (id) => {
      expect(
        problemsOf(() => loadEnableBanking({ ...eb, EB_APPLICATION_ID: id }, noFiles)),
      ).toEqual(["EB_APPLICATION_ID must be a UUID"]);
    },
  );

  it("rejects text that is not a PEM and a truncated PEM", () => {
    for (const bad of ["not a key", RSA_PKCS8.slice(0, 120)]) {
      expect(problemsOf(() => loadEnableBanking({ ...eb, EB_PRIVATE_KEY: bad }, noFiles))).toEqual([
        "EB_PRIVATE_KEY is not a valid unencrypted PEM private key (PKCS#1 or PKCS#8)",
      ]);
    }
  });

  it("rejects a key that is not RSA", () => {
    expect(
      problemsOf(() => loadEnableBanking({ ...eb, EB_PRIVATE_KEY: EC_PKCS8 }, noFiles)),
    ).toEqual(["EB_PRIVATE_KEY must be an RSA private key"]);
  });

  it("refuses the key and its _FILE variant together", () => {
    const env = { ...eb, EB_PRIVATE_KEY_FILE: "/run/secrets/eb_key" };
    expect(problemsOf(() => loadEnableBanking(env, noFiles))).toEqual([
      "EB_PRIVATE_KEY and EB_PRIVATE_KEY_FILE are both set; use one",
    ]);
  });

  it("reports an unreadable key file once, without a second 'required' problem", () => {
    const denied = () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    const env = { EB_APPLICATION_ID: APP_ID, EB_PRIVATE_KEY_FILE: "/run/secrets/eb_key" };
    const problems = problemsOf(() => loadEnableBanking(env, denied));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/EB_PRIVATE_KEY_FILE points to \/run\/secrets\/eb_key/);
  });

  it("reports an empty key file", () => {
    const env = { EB_APPLICATION_ID: APP_ID, EB_PRIVATE_KEY_FILE: "/run/secrets/eb_key" };
    expect(
      problemsOf(() => loadEnableBanking(env, filesOf({ "/run/secrets/eb_key": "\n" }))),
    ).toEqual(["EB_PRIVATE_KEY_FILE points to an empty file"]);
  });

  it("collects the Enable Banking problems with the others in loadConfig", () => {
    const problems = problemsOf(() =>
      loadConfig({ ...baseEnv, EB_APPLICATION_ID: "nope", EB_PRIVATE_KEY: "nope" }, noFiles),
    );
    expect(problems).toContain("EB_APPLICATION_ID must be a UUID");
    expect(problems.some((problem) => problem.startsWith("EB_PRIVATE_KEY is not a valid"))).toBe(
      true,
    );
  });
});

describe("SMTP configuration", () => {
  const smtp = { SMTP_HOST: "smtp.example.test", SMTP_FROM: "Bursar <bursar@example.test>" };

  it("is null when no SMTP variable is set, also through loadConfig", () => {
    expect(loadSmtp({}, noFiles)).toBeNull();
    expect(
      loadSmtp({ SMTP_HOST: " ", SMTP_PORT: "2525", SMTP_SECURITY: "tls" }, noFiles),
    ).toBeNull();
    expect(loadConfig(baseEnv, noFiles).smtp).toBeNull();
  });

  it("applies the defaults: port 587, STARTTLS, no credentials", () => {
    expect(loadSmtp(smtp, noFiles)).toEqual({
      host: "smtp.example.test",
      port: 587,
      security: "starttls",
      user: null,
      password: null,
      from: "Bursar <bursar@example.test>",
    });
    expect(loadConfig({ ...baseEnv, ...smtp }, noFiles).smtp?.host).toBe("smtp.example.test");
  });

  it("parses an explicit configuration with a user and a password", () => {
    expect(
      loadSmtp(
        {
          ...smtp,
          SMTP_PORT: " 465 ",
          SMTP_SECURITY: "TLS",
          SMTP_USER: "mailer",
          SMTP_PASSWORD: "smtp-password-value",
        },
        noFiles,
      ),
    ).toEqual({
      host: "smtp.example.test",
      port: 465,
      security: "tls",
      user: "mailer",
      password: "smtp-password-value",
      from: "Bursar <bursar@example.test>",
    });
  });

  it("reads the password from a *_FILE path", () => {
    const env = { ...smtp, SMTP_USER: "mailer", SMTP_PASSWORD_FILE: "/run/secrets/smtp_password" };
    const config = loadSmtp(
      env,
      filesOf({ "/run/secrets/smtp_password": "smtp-password-value\n" }),
    );
    expect(config?.password).toBe("smtp-password-value");
  });

  it("allows plain SMTP on loopback hosts only", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) {
      expect(loadSmtp({ ...smtp, SMTP_HOST: host, SMTP_SECURITY: "none" }, noFiles)?.security).toBe(
        "none",
      );
    }
    for (const host of ["smtp.example.test", "10.0.0.5", "128.0.0.1", "localhost.example.test"]) {
      expect(
        problemsOf(() => loadSmtp({ ...smtp, SMTP_HOST: host, SMTP_SECURITY: "none" }, noFiles)),
      ).toEqual(["SMTP_SECURITY=none is allowed only when SMTP_HOST is a loopback address"]);
    }
  });

  it("stores an IPv6 host without brackets", () => {
    expect(loadSmtp({ ...smtp, SMTP_HOST: "[2001:db8::25]" }, noFiles)?.host).toBe("2001:db8::25");
  });

  it("rejects a malformed host, port and security mode", () => {
    expect(problemsOf(() => loadSmtp({ ...smtp, SMTP_HOST: "bad host!" }, noFiles))).toEqual([
      "SMTP_HOST must be an IP address or a hostname",
    ]);
    for (const port of ["0", "65536", "25.5", "25abc", "-1"]) {
      expect(problemsOf(() => loadSmtp({ ...smtp, SMTP_PORT: port }, noFiles))).toEqual([
        "SMTP_PORT must be an integer between 1 and 65535",
      ]);
    }
    expect(problemsOf(() => loadSmtp({ ...smtp, SMTP_SECURITY: "ssl" }, noFiles))).toEqual([
      "SMTP_SECURITY must be one of tls, starttls, none",
    ]);
  });

  it("requires SMTP_FROM, as an address on a single line", () => {
    expect(problemsOf(() => loadSmtp({ SMTP_HOST: "smtp.example.test" }, noFiles))).toEqual([
      "SMTP_FROM is required when SMTP_HOST is set",
    ]);
    for (const from of ["Bursar", "a@example.test\nBcc: x@example.test"]) {
      expect(problemsOf(() => loadSmtp({ ...smtp, SMTP_FROM: from }, noFiles))).toEqual([
        "SMTP_FROM must be an email address or Name <address> on a single line",
      ]);
    }
  });

  it("requires the user and the password together", () => {
    const together = "SMTP_USER and SMTP_PASSWORD (or SMTP_PASSWORD_FILE) must be set together";
    expect(problemsOf(() => loadSmtp({ ...smtp, SMTP_USER: "mailer" }, noFiles))).toEqual([
      together,
    ]);
    expect(
      problemsOf(() => loadSmtp({ ...smtp, SMTP_PASSWORD: "smtp-password-value" }, noFiles)),
    ).toEqual([together]);
  });

  it("names SMTP_HOST when other SMTP variables are set without it", () => {
    const hostMissing = "SMTP_HOST is required when SMTP_FROM, SMTP_USER or SMTP_PASSWORD is set";
    expect(problemsOf(() => loadSmtp({ SMTP_FROM: "bursar@example.test" }, noFiles))).toEqual([
      hostMissing,
    ]);
    expect(problemsOf(() => loadSmtp({ SMTP_USER: "mailer" }, noFiles))).toEqual([hostMissing]);
    expect(problemsOf(() => loadSmtp({ SMTP_PASSWORD: "smtp-password-value" }, noFiles))).toEqual([
      hostMissing,
    ]);
  });

  it("refuses the password and its _FILE variant together, and reports an unreadable file", () => {
    expect(
      problemsOf(() =>
        loadSmtp(
          { ...smtp, SMTP_USER: "u", SMTP_PASSWORD: "x", SMTP_PASSWORD_FILE: "/f" },
          noFiles,
        ),
      ),
    ).toEqual(["SMTP_PASSWORD and SMTP_PASSWORD_FILE are both set; use one"]);
    const missing = () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const problems = problemsOf(() =>
      loadSmtp({ ...smtp, SMTP_USER: "mailer", SMTP_PASSWORD_FILE: "/run/secrets/smtp" }, missing),
    );
    expect(problems).toEqual([
      "SMTP_PASSWORD_FILE points to /run/secrets/smtp, which cannot be read (ENOENT)",
    ]);
  });
});

describe("backup configuration", () => {
  const s3 = {
    BACKUP_S3_ENDPOINT: "https://s3.example.test",
    BACKUP_S3_BUCKET: "bursar-backups",
    BACKUP_S3_ACCESS_KEY_ID: "access-key-id-value",
    BACKUP_S3_SECRET_KEY: "s3-secret-value-0123456789",
  };
  const dataDir = path.resolve("/srv/bursar-data");

  it("defaults to <dataDir>/backups with no S3 target", () => {
    expect(loadBackup({}, dataDir, noFiles)).toEqual({
      dir: path.join(dataDir, "backups"),
      s3: null,
    });
    expect(
      loadBackup({ BACKUP_S3_REGION: "eu-1", BACKUP_S3_PREFIX: "x" }, dataDir, noFiles).s3,
    ).toBeNull();
  });

  it("follows BURSAR_DATA_DIR and BURSAR_BACKUP_DIR through loadConfig", () => {
    const withData = loadConfig({ ...baseEnv, BURSAR_DATA_DIR: "/srv/data" }, noFiles);
    expect(withData.backup.dir).toBe(path.join(path.resolve("/srv/data"), "backups"));
    const explicit = loadConfig({ ...baseEnv, BURSAR_BACKUP_DIR: "/mnt/backups" }, noFiles);
    expect(explicit.backup.dir).toBe(path.resolve("/mnt/backups"));
    const blank = loadConfig({ ...baseEnv, BURSAR_BACKUP_DIR: "  " }, noFiles);
    expect(blank.backup.dir).toBe(path.join(blank.dataDir, "backups"));
  });

  it("parses a complete S3 target with the default region and prefix", () => {
    const backup = loadBackup(s3, dataDir, noFiles);
    expect(backup.s3).toEqual({
      endpoint: new URL("https://s3.example.test"),
      region: "auto",
      bucket: "bursar-backups",
      prefix: "bursar",
      accessKeyId: "access-key-id-value",
      secretAccessKey: "s3-secret-value-0123456789",
    });
    expect(backup.s3?.endpoint).toBeInstanceOf(URL);
  });

  it("reads the secret key from a *_FILE path", () => {
    const { BACKUP_S3_SECRET_KEY: _direct, ...rest } = s3;
    const env = { ...rest, BACKUP_S3_SECRET_KEY_FILE: "/run/secrets/s3_secret" };
    const backup = loadBackup(
      env,
      dataDir,
      filesOf({ "/run/secrets/s3_secret": "from-file-secret-value\n" }),
    );
    expect(backup.s3?.secretAccessKey).toBe("from-file-secret-value");
  });

  it("takes an explicit region and normalises the prefix", () => {
    const backup = loadBackup(
      { ...s3, BACKUP_S3_REGION: "eu-central-003", BACKUP_S3_PREFIX: "/finance/bursar/" },
      dataDir,
      noFiles,
    );
    expect(backup.s3).toMatchObject({ region: "eu-central-003", prefix: "finance/bursar" });
  });

  it.each([
    ["BACKUP_S3_ENDPOINT"],
    ["BACKUP_S3_BUCKET"],
    ["BACKUP_S3_ACCESS_KEY_ID"],
    ["BACKUP_S3_SECRET_KEY"],
  ])("names %s when it is the only one missing", (name) => {
    const env: Record<string, string | undefined> = { ...s3, [name]: undefined };
    const problems = problemsOf(() => loadBackup(env, dataDir, noFiles));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`also set ${name}`);
  });

  it("lists every missing variable when only one is set", () => {
    const problems = problemsOf(() =>
      loadBackup({ BACKUP_S3_BUCKET: "bursar-backups" }, dataDir, noFiles),
    );
    expect(problems).toEqual([
      "The S3 backup target is half configured; also set BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_KEY (or BACKUP_S3_SECRET_KEY_FILE)",
    ]);
  });

  it.each([
    ["http://s3.example.test", /BACKUP_S3_ENDPOINT must use https/],
    ["ftp://s3.example.test", /BACKUP_S3_ENDPOINT must use https/],
    ["https://user:pw@s3.example.test", /BACKUP_S3_ENDPOINT must not contain credentials/],
    ["https://s3.example.test/bucket", /BACKUP_S3_ENDPOINT must not contain a path/],
    ["s3.example.test", /BACKUP_S3_ENDPOINT must be an absolute https URL/],
  ])("rejects the endpoint %s", (endpoint, message) => {
    expect(
      problemsOf(() => loadBackup({ ...s3, BACKUP_S3_ENDPOINT: endpoint }, dataDir, noFiles)),
    ).toEqual([expect.stringMatching(message)]);
  });

  it.each(["UPPER", "ab", "has space", "-leading", "trailing-", "a".repeat(64)])(
    "rejects the bucket name %j",
    (bucket) => {
      expect(
        problemsOf(() => loadBackup({ ...s3, BACKUP_S3_BUCKET: bucket }, dataDir, noFiles)),
      ).toEqual([expect.stringMatching(/^BACKUP_S3_BUCKET must be a valid bucket name/)]);
    },
  );

  it("rejects a bad region and bad prefixes", () => {
    expect(
      problemsOf(() => loadBackup({ ...s3, BACKUP_S3_REGION: "eu central" }, dataDir, noFiles)),
    ).toEqual(["BACKUP_S3_REGION must contain only letters, digits and hyphens"]);
    for (const prefix of ["/", "a//b", "a/../b", "..", "a b", "café"]) {
      expect(
        problemsOf(() => loadBackup({ ...s3, BACKUP_S3_PREFIX: prefix }, dataDir, noFiles)),
      ).toEqual([expect.stringMatching(/^BACKUP_S3_PREFIX must be slash-separated segments/)]);
    }
  });

  it("is collected by loadConfig with the other problems", () => {
    const problems = problemsOf(() =>
      loadConfig({ ...baseEnv, BACKUP_S3_BUCKET: "bursar-backups", TZ: "Mars/Olympus" }, noFiles),
    );
    expect(problems.some((problem) => problem.includes("TZ"))).toBe(true);
    expect(
      problems.some((problem) => problem.includes("S3 backup target is half configured")),
    ).toBe(true);
  });
});

describe("secrets never appear in configuration problems", () => {
  it("keeps every secret value out of every problem message", () => {
    const keyLines = RSA_PKCS8.trim().split("\n");
    const secrets = [
      keyLines[1] as string,
      "smtp-password-value",
      "s3-secret-value-0123456789",
      "access-key-id-value",
    ];
    const attempts: Record<string, string>[] = [
      // Wrong key kind, bad id, bad SMTP mode, bad S3 endpoint, all at once.
      {
        EB_APPLICATION_ID: "nope",
        EB_PRIVATE_KEY: EC_PKCS8,
        SMTP_HOST: "bad host!",
        SMTP_FROM: "nobody",
        SMTP_SECURITY: "ssl",
        SMTP_USER: "mailer",
        SMTP_PASSWORD: "smtp-password-value",
        BACKUP_S3_ENDPOINT: "http://user:s3-secret-value-0123456789@s3.example.test",
        BACKUP_S3_BUCKET: "UPPER",
        BACKUP_S3_ACCESS_KEY_ID: "access-key-id-value",
        BACKUP_S3_SECRET_KEY: "s3-secret-value-0123456789",
      },
      // A truncated key (its body lines are the secret), a password without a user.
      {
        EB_APPLICATION_ID: APP_ID,
        EB_PRIVATE_KEY: RSA_PKCS8.slice(0, 120),
        SMTP_HOST: "smtp.example.test",
        SMTP_FROM: "bursar@example.test",
        SMTP_PASSWORD: "smtp-password-value",
        BACKUP_S3_SECRET_KEY: "s3-secret-value-0123456789",
      },
      // A key given together with its _FILE variant.
      {
        EB_APPLICATION_ID: APP_ID,
        EB_PRIVATE_KEY: RSA_PKCS8,
        EB_PRIVATE_KEY_FILE: "/run/secrets/eb_key",
      },
    ];
    for (const extra of attempts) {
      const error = (() => {
        try {
          loadConfig({ ...baseEnv, ...extra }, noFiles);
        } catch (caught) {
          return caught as ConfigError;
        }
        throw new Error("expected a ConfigError");
      })();
      for (const secret of secrets) {
        expect(error.message).not.toContain(secret);
        expect(error.problems.join("\n")).not.toContain(secret);
      }
    }
  });
});
