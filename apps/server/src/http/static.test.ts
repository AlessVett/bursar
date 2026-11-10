import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

describe("panel serving", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-web-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>panel</title>");
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    app = createApp({
      config: {
        publicUrl: new URL("https://bursar.example.test"),
        cfAccess: null,
        webDistDir: dir,
      },
      logger: pino({ level: "silent" }),
      healthCheck: () => true,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("serves index.html at the root and for client-side routes", async () => {
    for (const route of ["/", "/accounts/123"]) {
      const res = await app.request(route);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>panel</title>");
    }
  });

  it("serves hashed assets with long-lived caching", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("console.log(1)");
  });

  it("never serves files outside the build directory", async () => {
    const res = await app.request("/..%2f..%2f..%2fetc%2fpasswd");
    expect(await res.text()).toContain("<title>panel</title>");
  });

  it("keeps API 404s as JSON", async () => {
    expect((await app.request("/api/unknown")).status).toBe(404);
  });

  it("answers 404 for a missing hashed asset instead of the panel", async () => {
    const res = await app.request("/assets/missing-0123abcd.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).not.toContain("<title>panel</title>");
  });

  it("answers 404 for any missing path whose last segment has a file extension", async () => {
    for (const route of ["/favicon.ico", "/robots.txt", "/accounts/report.pdf"]) {
      const res = await app.request(route);
      expect(res.status, route).toBe(404);
    }
  });

  it("keeps the panel fallback for client routes without an extension", async () => {
    for (const route of ["/transactions", "/accounts/12", "/connect/callback?state=a.b"]) {
      const res = await app.request(route);
      expect(res.status, route).toBe(200);
      expect(await res.text()).toContain("<title>panel</title>");
    }
  });

  it("serves file bodies from memory after the first read", async () => {
    expect(await (await app.request("/assets/app.js")).text()).toBe("console.log(1)");
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log(2)");
    expect(await (await app.request("/assets/app.js")).text()).toBe("console.log(1)");
  });
});
