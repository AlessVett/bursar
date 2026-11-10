import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createClientIpResolver, isPublicIp } from "./client-ip";

function probe(trustCfConnectingIp: boolean): Hono {
  const resolve = createClientIpResolver(trustCfConnectingIp);
  const app = new Hono();
  app.get("/", (c) => c.text(resolve(c)));
  return app;
}

/** The bindings `@hono/node-server` passes to the app (only the socket part is read). */
function socket(remoteAddress: string | undefined) {
  return { incoming: { socket: { remoteAddress } } };
}

describe("createClientIpResolver", () => {
  it("ignores CF-Connecting-IP when the edge is not trusted", async () => {
    const response = await probe(false).request(
      "/",
      { headers: { "cf-connecting-ip": "203.0.113.5" } },
      socket("10.0.0.2"),
    );
    expect(await response.text()).toBe("10.0.0.2");
  });

  it("uses the trimmed CF-Connecting-IP when the edge is trusted", async () => {
    const response = await probe(true).request(
      "/",
      { headers: { "cf-connecting-ip": " 203.0.113.5 " } },
      socket("10.0.0.2"),
    );
    expect(await response.text()).toBe("203.0.113.5");
  });

  it("falls back to the socket address when the trusted header is missing or blank", async () => {
    const missing = await probe(true).request("/", {}, socket("10.0.0.2"));
    expect(await missing.text()).toBe("10.0.0.2");
    const blank = await probe(true).request(
      "/",
      { headers: { "cf-connecting-ip": "   " } },
      socket("10.0.0.3"),
    );
    expect(await blank.text()).toBe("10.0.0.3");
  });

  it("answers unknown without connection information", async () => {
    const noBindings = await probe(false).request("/");
    expect(await noBindings.text()).toBe("unknown");
    const noAddress = await probe(false).request("/", {}, socket(undefined));
    expect(await noAddress.text()).toBe("unknown");
  });
});

describe("isPublicIp", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.5.4",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.10.1",
    "100.64.0.1",
    "100.127.255.254",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd12:3456::1",
    "fc00::1",
    "fe80::1",
    "fe80::1%eth0",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "ff02::1",
    "unknown",
    "",
    "not-an-ip",
    "1.2.3",
    "999.1.1.1",
  ])("treats %j as not public", (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each([
    "203.0.113.7",
    "198.51.100.20",
    "172.32.0.1",
    "100.128.0.1",
    "11.0.0.1",
    "192.169.0.1",
    "2001:db8::7",
    "[2001:db8::7]",
    "::ffff:203.0.113.7",
  ])("treats %j as public", (ip) => {
    expect(isPublicIp(ip)).toBe(true);
  });
});
