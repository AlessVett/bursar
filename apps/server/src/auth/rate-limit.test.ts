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
});
