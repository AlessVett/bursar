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

  it("refuses a non-loopback public URL without Cloudflare Access (fail closed)", () => {
    const { CF_ACCESS_TEAM_DOMAIN: _t, CF_ACCESS_AUD: _a, ...noAccess } = baseEnv;
    expect(() => loadConfig(noAccess, noFiles)).toThrow(/are required unless/);
  });

  it("allows a loopback public URL without Cloudflare Access", () => {
    const { CF_ACCESS_TEAM_DOMAIN: _t, CF_ACCESS_AUD: _a, ...noAccess } = baseEnv;
    const config = loadConfig({ ...noAccess, BURSAR_PUBLIC_URL: "http://localhost:5173" }, noFiles);
    expect(config.cfAccess).toBeNull();
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
