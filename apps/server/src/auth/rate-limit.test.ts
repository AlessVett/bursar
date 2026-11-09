import { describe, expect, it } from "vitest";
import { FailureLimiter } from "./rate-limit";

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
