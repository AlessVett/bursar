import { BlockList, isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/**
 * Resolves the client address for rate limiting (auth) and PSU headers (manual sync).
 * CF-Connecting-IP is set by Cloudflare's edge; any other client could forge it, so it is
 * honoured only when the operator says the app is reachable through Cloudflare alone.
 */
export function createClientIpResolver(trustCfConnectingIp: boolean): (c: Context) => string {
  return (c) => {
    const forwarded = trustCfConnectingIp ? c.req.header("cf-connecting-ip")?.trim() : undefined;
    if (forwarded) return forwarded;
    try {
      return getConnInfo(c).remote.address || "unknown";
    } catch {
      // No Node socket bindings (in-process `app.request` in tests).
      return "unknown";
    }
  };
}

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network", includes the unspecified 0.0.0.0
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes broadcast
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
NON_PUBLIC.addAddress("::", "ipv6"); // unspecified
NON_PUBLIC.addAddress("::1", "ipv6"); // loopback
for (const [network, prefix] of [
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["100::", 64], // discard-only
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/**
 * True when the address can be a real user's public address, so forwarding it to the bank as
 * `Psu-Ip-Address` is meaningful. IPv4-mapped IPv6 addresses are checked against the IPv4
 * rules (Node's BlockList does that). Documentation ranges (192.0.2/24, 198.51.100/24,
 * 203.0.113/24, 2001:db8::/32) are deliberately not excluded: they never occur on real
 * traffic and tests use them as fictional public addresses.
 */
export function isPublicIp(ip: string): boolean {
  let value = ip.trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  const family = isIP(value);
  if (family === 4) return !NON_PUBLIC.check(value, "ipv4");
  if (family === 6) return !NON_PUBLIC.check(value, "ipv6");
  return false;
}
