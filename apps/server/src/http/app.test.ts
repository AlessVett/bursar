import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const ORIGIN = "https://bursar.example.test";
const config = { publicUrl: new URL(ORIGIN), cfAccess: null, webDistDir: null };
const logger = pino({ level: "silent" });

describe("createApp", () => {
  it("reports health", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 503 when the health check fails", async () => {
    const app = createApp({ config, logger, healthCheck: () => false });
    expect((await app.request("/healthz")).status).toBe(503);
  });

  it("sets a strict content security policy", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/healthz");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("rejects mutating API requests without the panel's origin", async () => {
    const app = createApp({ config, logger, healthCheck: () => true });
    const post = (headers: Record<string, string>) =>
      app.request("/api/nope", { method: "POST", headers });
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: ORIGIN })).status).toBe(404);
  });
});
