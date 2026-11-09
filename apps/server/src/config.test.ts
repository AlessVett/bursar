import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, readSecret } from "./config";

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
});
