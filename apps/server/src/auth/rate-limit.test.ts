import { describe, expect, it } from "vitest";
import { FailureLimiter, rateLimitKey } from "./rate-limit";

describe("rateLimitKey", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:db8:0:0:ffff:ffff:ffff:ffff", "2001:db8:0:0::/64"],
    ["2001:DB8:0:1::1", "2001:db8:0:1::/64"],
    ["[2001:db8::1]", "2001:db8:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::ffff:cb00:7107", "203.0.113.7"],
    ["64:ff9b::203.0.113.7", "64:ff9b:0:0::/64"],
    ["unknown", "unknown"],
  ])("maps %s to %s", (address, key) => {
    expect(rateLimitKey(address)).toBe(key);
  });

  it("gives every address in one IPv6 /64 the same key", () => {
    const keys = new Set(
      Array.from({ length: 7 }, (_, i) => rateLimitKey(`2001:db8:abcd:12::${i.toString(16)}`)),
    );
    expect(keys.size).toBe(1);
    expect(rateLimitKey("2001:db8:abcd:13::1")).not.toBe([...keys][0]);
  });
});

describe("FailureLimiter", () => {
  it("blocks a key after the maximum failures within the window", () => {
    let now = 0;
    const limiter = new FailureLimiter(3, 1_000, () => now);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(true);
    expect(limiter.isBlocked("other")).toBe(false);
    now = 1_000;
    expect(limiter.isBlocked("ip")).toBe(false);
  });

  it("forgets failures on reset", () => {
    const limiter = new FailureLimiter(1, 1_000, () => 0);
    limiter.recordFailure("ip");
    limiter.reset("ip");
    expect(limiter.isBlocked("ip")).toBe(false);
  });

  it("tryConsume caps a concurrent burst while verification is pending", async () => {
    const limiter = new FailureLimiter(5, 1_000, () => 0);
    const verify = async (): Promise<boolean> => {
      if (!limiter.tryConsume("ip")) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    };
    const results = await Promise.all(Array.from({ length: 20 }, verify));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(limiter.isBlocked("ip")).toBe(true);
  });

  it("tryConsume allows a fresh window and a reset after success", () => {
    let now = 0;
    const limiter = new FailureLimiter(1, 1_000, () => now);
    expect(limiter.tryConsume("ip")).toBe(true);
    expect(limiter.tryConsume("ip")).toBe(false);
    limiter.reset("ip");
    expect(limiter.tryConsume("ip")).toBe(true);
    now = 1_000;
    expect(limiter.tryConsume("ip")).toBe(true);
  });
});
